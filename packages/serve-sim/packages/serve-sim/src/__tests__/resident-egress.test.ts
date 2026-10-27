import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { formatCapabilityConfig, capabilityConfigPath } from "../capability-config";
import { readLaunchState, writeLaunchState, type RecordedCapability } from "../launch-state";
import { disableCapability, releaseLaunchState } from "../launch-manager";
import { useTempStateDir } from "./helpers";

let state: ReturnType<typeof useTempStateDir>;
const udid = "11111111-1111-4111-8111-111111111111";
function enrollment(): RecordedCapability {
  return {
    name: "egressGuard",
    dylib: join(state.dir, "libServeSimEgressGuard.dylib"),
    env: { SERVE_SIM_EGRESS_POLICY_FILE: join(state.dir, "policy") },
    scope: "allProcesses",
    loadPhase: "startup",
    bundleId: null,
    ownerPid: null,
    resident: { boot: { pid: 123, startedAt: "1720000000:123456" }, warmupPolicy: "passthrough" },
  };
}
beforeEach(() => {
  state = useTempStateDir();
});
afterEach(() => state.restore());

test("all-process records are startup-only and cannot defer initialization", () => {
  const guard = enrollment();
  expect(formatCapabilityConfig({ egressGuard: guard })).toBe(
    `startup\tprocess\t${guard.dylib}\tSERVE_SIM_EGRESS_POLICY_FILE=${guard.env!.SERVE_SIM_EGRESS_POLICY_FILE}\t0\n`,
  );
  for (const loadPhase of [undefined, "deferred", "startupAndDeferred"] as const) {
    expect(() => formatCapabilityConfig({ egressGuard: { ...guard, loadPhase } })).toThrow(
      "startup-only",
    );
  }
});

test("session release retains enrollment and its startup config record for later helpers", () => {
  const guard = enrollment();
  writeLaunchState(udid, {
    launchArgs: [],
    sessionPids: [process.pid],
    capabilities: {
      egressGuard: guard,
      camera: {
        ...guard,
        name: "camera",
        scope: "userApps",
        resident: undefined,
        ownerPid: process.pid,
      },
    },
  });
  expect(releaseLaunchState(udid, process.pid)).toBe(true);
  expect(readLaunchState(udid)?.capabilities).toEqual({ egressGuard: guard });
  expect(readFileSync(capabilityConfigPath(udid), "utf8")).toBe(
    formatCapabilityConfig({ egressGuard: guard }),
  );
});

test("generic capability disable cannot withdraw resident enrollment", async () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  await expect(disableCapability(udid, null, "egressGuard", { relaunch: false })).rejects.toThrow(
    "policy",
  );
  expect(readLaunchState(udid)?.capabilities.egressGuard).toEqual(guard);
});

test("malformed resident metadata cannot be silently discarded as a stale app capability", () => {
  const guard = enrollment();
  writeFileSync(
    join(state.dir, `launch-${udid}.json`),
    JSON.stringify({
      launchArgs: [],
      capabilities: { egressGuard: { ...guard, resident: { boot: { pid: 123 } } } },
    }),
  );
  expect(() => readLaunchState(udid)).toThrow("resident");
});

test("ordinary config publication preserves the resident record unchanged", () => {
  const guard = enrollment();
  writeLaunchState(udid, { launchArgs: [], capabilities: { egressGuard: guard } });
  const current = readLaunchState(udid)!;
  const camera: RecordedCapability = {
    name: "camera",
    scope: "userApps",
    dylib: "/camera.dylib",
    bundleId: null,
    ownerPid: process.pid,
  };
  writeLaunchState(udid, { ...current, capabilities: { ...current.capabilities, camera } });
  const contents = formatCapabilityConfig(readLaunchState(udid)!.capabilities);
  expect(contents).toContain(formatCapabilityConfig({ egressGuard: guard }));
  expect(contents).toContain("user\t/camera.dylib");
});
