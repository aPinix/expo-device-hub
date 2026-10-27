import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import type { CapabilityLoadPhase, CapabilityScope } from "./capabilities";
import { stateDir } from "./state";

function isCapabilityScope(value: unknown): value is CapabilityScope {
  return value === "userApps" || value === "allApps" || value === "allProcesses";
}

/** The native launchd_sim process, including its microsecond start time. */
export interface SimulatorBootIdentity {
  pid: number;
  startedAt: string;
}

export interface Capability {
  name: string;
  dylib: string;
  env?: Record<string, string>;
  scope: CapabilityScope;
  loadDelayMs?: number;
  loadPhase?: CapabilityLoadPhase;
}

export interface RecordedCapability extends Capability {
  /** The app to relaunch, when one was named. Never narrows what loads. */
  bundleId: string | null;
  /** Null keeps the capability alive after a one-shot command exits. */
  ownerPid: number | null;
  /** Boot enrollment survives session release; policy changes do not withdraw it. */
  resident?: {
    /** Null only between preboot preparation and binding the new Simulator boot. */
    boot: SimulatorBootIdentity | null;
    warmupPolicy: "passthrough" | "block";
    assets?: { hashes: Record<string, string>; pageIdentity: string };
  };
}

export interface LaunchState {
  sessionPids?: number[];
  bundleId?: string;
  launchArgs: string[];
  capabilities: Record<string, RecordedCapability>;
}

function stateFile(udid: string): string {
  return join(stateDir(), `launch-${udid}.json`);
}

export function ownerIsGone(ownerPid: number | null): boolean {
  if (ownerPid === null) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch {
    return true;
  }
}

export function readLaunchState(udid: string, retainOwnerPid?: number): LaunchState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile(udid), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bundleId, launchArgs, capabilities, sessionPids } = parsed as Partial<LaunchState>;
  return {
    ...(typeof bundleId === "string" && bundleId ? { bundleId } : {}),
    launchArgs: Array.isArray(launchArgs)
      ? launchArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
    capabilities: recordedCapabilities(capabilities, retainOwnerPid),
    ...(Array.isArray(sessionPids)
      ? {
          sessionPids: sessionPids.filter(
            (pid) => Number.isInteger(pid) && pid > 0 && !ownerIsGone(pid),
          ),
        }
      : {}),
  };
}

// Discard malformed records and capabilities whose owner has exited.
function recordedCapabilities(
  value: unknown,
  retainOwnerPid?: number,
): Record<string, RecordedCapability> {
  if (typeof value !== "object" || value === null) return {};
  const kept: Record<string, RecordedCapability> = {};
  for (const [key, record] of Object.entries(value)) {
    if (typeof record !== "object" || record === null) continue;
    const { name, dylib, scope, bundleId, ownerPid, resident, loadPhase, env } =
      record as Partial<RecordedCapability>;
    if (resident !== undefined || scope === "allProcesses") {
      const boot = resident?.boot;
      if (
        key !== "egressGuard" ||
        name !== key ||
        scope !== "allProcesses" ||
        loadPhase !== "startup" ||
        ownerPid !== null ||
        !resident ||
        (resident.warmupPolicy !== "passthrough" && resident.warmupPolicy !== "block") ||
        (boot !== null &&
          (!boot ||
            !Number.isSafeInteger(boot.pid) ||
            boot.pid <= 1 ||
            typeof boot.startedAt !== "string" ||
            !/^\d+:\d{1,6}$/.test(boot.startedAt))) ||
        typeof dylib !== "string" ||
        !isAbsolute(dylib) ||
        !env?.SERVE_SIM_EGRESS_POLICY_FILE ||
        !isAbsolute(env.SERVE_SIM_EGRESS_POLICY_FILE)
      ) {
        throw new Error(
          "Invalid resident egress enrollment; preserve its files and restart the Simulator before repair.",
        );
      }
    }
    if (typeof name !== "string" || typeof dylib !== "string" || !isCapabilityScope(scope)) {
      continue;
    }
    const owner = typeof ownerPid === "number" ? ownerPid : null;
    if (owner !== retainOwnerPid && ownerIsGone(owner)) continue;
    kept[key] = {
      ...(record as RecordedCapability),
      bundleId: typeof bundleId === "string" ? bundleId : null,
      ownerPid: owner,
    };
  }
  return kept;
}

export function clearLaunchState(udid: string): void {
  const previous = readLaunchState(udid);
  const resident = Object.fromEntries(
    Object.entries(previous?.capabilities ?? {}).filter(([, capability]) => capability.resident),
  );
  if (Object.keys(resident).length) {
    writeLaunchState(udid, { launchArgs: [], capabilities: resident });
    return;
  }
  try {
    unlinkSync(stateFile(udid));
  } catch {}
}

export function writeLaunchState(udid: string, state: LaunchState): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
  const target = stateFile(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, target);
}
