import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  assertResidentConfigRetained,
  capabilityConfigPath,
  capabilityLoaderDir,
  capabilityLoaderPath,
  commitCapabilityConfig,
  formatCapabilityConfig,
  renderCapabilityConfig,
} from "./capability-config";
import {
  readLaunchState,
  writeLaunchState,
  clearLaunchState,
  type RecordedCapability,
  type SimulatorBootIdentity,
} from "./launch-state";
import { withLaunchStateLock } from "./launch-state-lock";
import { stateDir } from "./state";

export type EgressPolicy = "passthrough" | "block";
const execute = promisify(execFile);
const artifacts = [
  "libServeSimEgressGuard.dylib",
  "libServeSimCapabilityLoader.dylib",
  "serve-sim-egress-control",
  "serve-sim-egress-boot-identity",
] as const;

function canonicalDevice(udid: string): string {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid))
    throw new Error("Resident egress requires an exact Simulator UDID");
  return udid.toUpperCase();
}

function digest(path: string): string {
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== process.getuid!())
    throw new Error(`Invalid resident egress artifact: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function helper(path: string, args: string[]): Promise<unknown> {
  const { stdout } = await execute(path, args, {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8192,
  });
  return JSON.parse(stdout);
}
function pageIdentity(path: string): string {
  const file = lstatSync(path, { bigint: true });
  if (
    !file.isFile() ||
    file.size !== 4096n ||
    file.uid !== BigInt(process.getuid!()) ||
    (file.mode & 0o777n) !== 0o600n
  )
    throw new Error("Invalid resident egress control page");
  return `${file.dev}:${file.ino}`;
}
export async function simulatorEgressBoot(
  udid: string,
  directory: string,
): Promise<SimulatorBootIdentity | null> {
  udid = canonicalDevice(udid);
  const result = await helper(join(directory, "serve-sim-egress-boot-identity"), [udid]);
  if (result === null) return null;
  const boot = result as Partial<SimulatorBootIdentity>;
  if (
    !Number.isSafeInteger(boot?.pid) ||
    boot.pid! <= 1 ||
    typeof boot.startedAt !== "string" ||
    !/^\d+:\d{1,6}$/.test(boot.startedAt)
  )
    throw new Error("Invalid Simulator boot identity from egress helper");
  return boot as SimulatorBootIdentity;
}
function sameBoot(a: SimulatorBootIdentity | null, b: SimulatorBootIdentity | null): boolean {
  return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
}
export function residentEgress(udid: string): RecordedCapability | undefined {
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid)) udid = udid.toUpperCase();
  const state = readLaunchState(udid);
  assertResidentConfigRetained(
    udid,
    renderCapabilityConfig(state ?? { launchArgs: [], capabilities: {} }),
  );
  return state?.capabilities.egressGuard?.resident ? state.capabilities.egressGuard : undefined;
}
export async function checkResidentEgress(udid: string): Promise<RecordedCapability> {
  const guard = residentEgress(udid);
  const saved = guard?.resident;
  if (!guard || !saved?.boot || !saved.assets)
    throw new Error(
      "No compatible resident egress enrollment for this Simulator boot; use a cold start",
    );
  await checkAssets(udid, guard);
  if (!sameBoot(saved.boot, await simulatorEgressBoot(udid, dirname(guard.dylib))))
    throw new Error("Simulator boot changed; the old resident egress enrollment cannot be reused");
  return guard;
}

async function checkAssets(udid: string, guard: RecordedCapability): Promise<void> {
  const saved = guard.resident;
  if (!saved?.assets) throw new Error("Resident egress asset identity is unavailable");
  const expected = formatCapabilityConfig({ egressGuard: guard }).trimEnd();
  let startup = "";
  try {
    startup = readFileSync(capabilityConfigPath(udid), "utf8");
  } catch (error) {
    throw new Error("Resident egress startup record is unavailable", { cause: error });
  }
  if (!startup.split("\n").includes(expected))
    throw new Error("Resident egress startup record changed");
  const directory = dirname(guard.dylib);
  for (const name of artifacts) {
    if (digest(join(directory, name)) !== saved.assets.hashes[name])
      throw new Error("Resident egress artifact changed; preserve the old boot assets");
  }
  if (pageIdentity(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!) !== saved.assets.pageIdentity)
    throw new Error("Resident egress page was replaced; preserve the original mapping");
  const status = (await helper(join(directory, "serve-sim-egress-control"), [
    "status",
    guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!,
  ])) as {
    publishedGeneration?: unknown;
    policy?: unknown;
    warmupPolicy?: unknown;
    drained?: unknown;
  };
  if (
    !Number.isSafeInteger(status.publishedGeneration) ||
    Number(status.publishedGeneration) < 1 ||
    (status.policy !== "passthrough" && status.policy !== "block") ||
    status.warmupPolicy !== saved.warmupPolicy ||
    status.drained !== false
  )
    throw new Error("Invalid resident egress control state");
}

/** Called under the existing device lock before the selected Simulator can boot. */
export async function prepareResidentEgress(udid: string, policy: EgressPolicy): Promise<void> {
  udid = canonicalDevice(udid);
  await withLaunchStateLock(udid, async () => {
    if (residentEgress(udid))
      throw new Error(
        "Resident egress is already enrolled; use its policy path instead of replacing it",
      );
    const packaged = join(capabilityLoaderDir(), "..", "egress-guard");
    if (await simulatorEgressBoot(udid, packaged))
      throw new Error("Cannot retrofit resident egress into an already-booted Simulator");
    const previous = readLaunchState(udid);
    let oldConfig: string | null = null;
    try {
      oldConfig = readFileSync(capabilityConfigPath(udid), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    mkdirSync(stateDir(), { recursive: true });
    const directory = mkdtempSync(join(stateDir(), `egress-${udid}-`));
    const page = join(directory, "policy");
    const owned: string[] = [];
    let recorded = false;
    try {
      const hashes: Record<string, string> = {};
      for (const name of artifacts) {
        const source =
          name === "libServeSimCapabilityLoader.dylib"
            ? capabilityLoaderPath()
            : join(packaged, name);
        const destination = join(directory, name);
        copyFileSync(source, destination);
        owned.push(destination);
        chmodSync(destination, name.endsWith(".dylib") ? 0o400 : 0o500);
        hashes[name] = digest(destination);
      }
      owned.push(page);
      await helper(join(directory, "serve-sim-egress-control"), ["create", page, policy]);
      const guard: RecordedCapability = {
        name: "egressGuard",
        scope: "allProcesses",
        loadPhase: "startup",
        ownerPid: null,
        bundleId: null,
        dylib: join(directory, artifacts[0]),
        env: { SERVE_SIM_EGRESS_POLICY_FILE: page },
        resident: {
          boot: null,
          warmupPolicy: policy,
          assets: { hashes, pageIdentity: pageIdentity(page) },
        },
      };
      // Enrollment precedes config publication and boot; it is not an admission acknowledgement.
      writeLaunchState(udid, {
        ...(previous ?? { launchArgs: [], capabilities: {} }),
        capabilities: { ...previous?.capabilities, egressGuard: guard },
      });
      recorded = true;
      commitCapabilityConfig(udid, renderCapabilityConfig(readLaunchState(udid)!));
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        if (recorded) {
          writeLaunchState(udid, previous ?? { launchArgs: [], capabilities: {} });
          if (!previous) clearLaunchState(udid);
          let currentConfig: string | null = null;
          try {
            currentConfig = readFileSync(capabilityConfigPath(udid), "utf8");
          } catch (cleanup) {
            if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup;
          }
          if (currentConfig !== oldConfig) {
            if (oldConfig === null) unlinkSync(capabilityConfigPath(udid));
            else commitCapabilityConfig(udid, oldConfig);
          }
        }
      } catch (cleanup) {
        failures.push(cleanup);
      }
      // Only this fresh preboot child's named files are eligible for cleanup. Never recurse.
      if (failures.length === 1) {
        for (const path of owned.reverse()) {
          try {
            unlinkSync(path);
          } catch (cleanup) {
            if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanup);
          }
        }
        try {
          rmdirSync(directory);
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Egress preparation and cleanup failed; retain uncertain assets",
        );
      throw error;
    }
  });
}

/** Postboot errors retain the startup record and files: processes may already map them. */
export async function bindResidentEgressBoot(udid: string): Promise<void> {
  udid = canonicalDevice(udid);
  await withLaunchStateLock(udid, async () => {
    const state = readLaunchState(udid);
    const guard = residentEgress(udid);
    if (!state || !guard?.resident || guard.resident.boot)
      throw new Error("No pending resident egress boot enrollment");
    await checkAssets(udid, guard);
    const boot = await simulatorEgressBoot(udid, dirname(guard.dylib));
    if (!boot) throw new Error("Cannot identify the selected Simulator boot");
    state.capabilities.egressGuard = { ...guard, resident: { ...guard.resident, boot } };
    writeLaunchState(udid, state);
    await checkResidentEgress(udid);
  });
}

/** Publication only. Callers must independently establish admission/coverage/draining. */
export async function publishResidentEgressPolicy(
  udid: string,
  policy: EgressPolicy,
): Promise<void> {
  udid = canonicalDevice(udid);
  await withLaunchStateLock(udid, async () => {
    const guard = await checkResidentEgress(udid);
    const command = join(dirname(guard.dylib), "serve-sim-egress-control");
    try {
      const result = (await helper(command, [
        "set",
        guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!,
        policy,
      ])) as { policy?: unknown; publishedGeneration?: unknown; drained?: unknown };
      if (
        result.policy !== policy ||
        !Number.isSafeInteger(result.publishedGeneration) ||
        Number(result.publishedGeneration) < 1 ||
        result.drained !== false
      )
        throw new Error("Egress policy publication failed");
      await checkResidentEgress(udid);
    } catch (error) {
      try {
        await checkResidentEgress(udid);
        const blocked = (await helper(command, [
          "set",
          guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!,
          "block",
        ])) as { policy?: unknown; publishedGeneration?: unknown; drained?: unknown };
        if (
          blocked.policy !== "block" ||
          !Number.isSafeInteger(blocked.publishedGeneration) ||
          Number(blocked.publishedGeneration) < 1 ||
          blocked.drained !== false
        )
          throw new Error("Blocking cleanup publication failed");
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Egress policy update and blocking cleanup failed; preserve the resident mapping",
        );
      }
      throw error;
    }
  });
}
