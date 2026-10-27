import type { CapabilityDefinition, CapabilityOverrides } from "./capabilities";
import { withLaunchStateLock } from "./launch-state-lock";
import type { SimulatorBootIdentity } from "./launch-state";
import {
  assertEgressSessionOwner,
  bindResidentEgressBoot,
  checkResidentEgress,
  prepareResidentEgress,
  publishResidentEgressPolicy,
  publishResidentEgressPolicyUnlocked,
  residentEgress,
  type EgressPolicy,
} from "./egress-resources";

export const egressGuardCapability: CapabilityDefinition = {
  name: "egressGuard",
  defaultEnabled: false,
  exclusive: true,
  scope: "allProcesses",
  loadPhase: "startup",
  async setEnabled() {
    throw new Error("Resident egress policy requires the strict startup or private adoption path.");
  },
};

export function egressPolicyOverride({
  enable = [],
  disable = [],
}: CapabilityOverrides): EgressPolicy | undefined {
  const on = enable.includes("egressGuard"),
    off = disable.includes("egressGuard");
  if (on && off)
    throw new Error("Choose either --enable egressGuard or --disable egressGuard, not both.");
  return on ? "block" : off ? "passthrough" : undefined;
}

// @ref LLP 0007.001#integration-layers — source wiring must not turn publication into a positive enforcement acknowledgement
function requireEnforcement(): void {
  throw new Error(
    "Resident egress enforcement is unavailable: performance, all-process coverage and in-flight draining remain unvalidated. No session or app was admitted.",
  );
}

export async function requiredEgressStartup(
  udid: string,
  policy: EgressPolicy | undefined,
  boot: () => Promise<void>,
): Promise<boolean> {
  const existing = residentEgress(udid);
  if (policy === undefined) {
    if (existing)
      throw new Error(
        "Resident egress startup requires an explicit --enable egressGuard or --disable egressGuard choice.",
      );
    return false;
  }
  // This held source integration has no runtime flag or caller assertion that bypasses this gate.
  requireEnforcement();
  if (!existing) {
    await prepareResidentEgress(udid, policy);
    await boot();
    await bindResidentEgressBoot(udid);
  }
  await publishResidentEgressPolicy(udid, policy);
  // The native coverage/drain protocol must replace requireEnforcement before enabling this path.
  return true;
}

/** Host stream helpers observe the existing boot; they never own a policy choice. */
export async function checkEgressStreamHelper(
  udid: string,
  expected?: SimulatorBootIdentity,
): Promise<SimulatorBootIdentity | null> {
  if (!residentEgress(udid)) {
    if (expected) throw new Error("Resident egress enrollment disappeared during helper startup");
    return null;
  }
  udid = udid.toUpperCase();
  return withLaunchStateLock(udid, async () => {
    const guard = await checkResidentEgress(udid);
    const boot = guard.resident!.boot!;
    if (expected && (boot.pid !== expected.pid || boot.startedAt !== expected.startedAt))
      throw new Error("Simulator boot changed during helper startup");
    return { ...boot };
  });
}

async function compatibleEgressAdoption(
  udid: string,
  requested: unknown,
  ownerPid: number,
): Promise<EgressPolicy | undefined> {
  if (requested !== undefined && requested !== "block" && requested !== "passthrough")
    throw new Error("Invalid resident egress policy");
  const existing = residentEgress(udid);
  if (requested === undefined && !existing) return undefined;
  if (!existing) throw new Error("No compatible resident egress enrollment; use a cold start");
  if (requested === undefined)
    throw new Error(
      "Resident adoption requires an explicit --enable egressGuard or --disable egressGuard choice",
    );
  assertEgressSessionOwner(udid, ownerPid);
  await checkResidentEgress(udid);
  return requested;
}

/** Compatibility only: no policy mutation and no enforcement/drain acknowledgement. */
export async function preflightEgressAdoption(
  udid: string,
  requested: unknown,
  ownerPid: number,
): Promise<void> {
  udid = udid.toUpperCase();
  await withLaunchStateLock(udid, () => compatibleEgressAdoption(udid, requested, ownerPid));
}

export async function requiredEgressAdoption(
  udid: string,
  policy: EgressPolicy | undefined,
  signal: AbortSignal,
): Promise<void> {
  udid = udid.toUpperCase();
  try {
    await withLaunchStateLock(udid, async () => {
      signal.throwIfAborted();
      const requested = await compatibleEgressAdoption(udid, policy, process.pid);
      signal.throwIfAborted();
      if (requested === undefined) return;
      requireEnforcement();
      await publishResidentEgressPolicyUnlocked(udid, requested);
      signal.throwIfAborted();
    });
  } catch (error) {
    // The private owner keeps its generic response; retain policy and cleanup causes for the operator.
    if (policy !== undefined) console.error("[serve-sim] egress adoption failed", error);
    throw error;
  }
}
