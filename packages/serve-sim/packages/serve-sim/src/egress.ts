import type { CapabilityDefinition, CapabilityOverrides } from "./capabilities";
import { withLaunchStateLock } from "./launch-state-lock";
import {
  bindResidentEgressBoot,
  checkResidentEgress,
  prepareResidentEgress,
  publishResidentEgressPolicy,
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
export async function checkEgressStreamHelper(udid: string): Promise<boolean> {
  if (!residentEgress(udid)) return false;
  await withLaunchStateLock(udid, () => checkResidentEgress(udid));
  return true;
}
