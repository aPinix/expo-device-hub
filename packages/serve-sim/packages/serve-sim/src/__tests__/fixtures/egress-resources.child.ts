import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as config from "../../capability-config";
import { readLaunchState } from "../../launch-state";
import { releaseLaunchState } from "../../launch-manager";
import { useTempStateDir } from "../helpers";

const work = mkdtempSync("/tmp/serve-sim-egress-resources-");
const source = join(work, "capability-loader"),
  native = join(work, "egress-guard");
const bootFile = join(work, "boot.json");
const failingSet = join(work, "failing-set");
const udid = "11111111-1111-4111-8111-111111111111";
mkdirSync(source);
mkdirSync(native);
writeFileSync(
  join(source, "libServeSimCapabilityLoader.dylib"),
  "loader fixture, not a native image",
);
writeFileSync(join(native, "libServeSimEgressGuard.dylib"), "guard fixture, not a native image");
writeFileSync(
  join(native, "serve-sim-egress-boot-identity"),
  `#!/usr/bin/env node\nconsole.log(require('fs').readFileSync(${JSON.stringify(bootFile)}, 'utf8'));\n`,
  { mode: 0o500 },
);
const controller = `#!/usr/bin/env node
const fs = require('fs');
const [command, path, policy] = process.argv.slice(2);
if(command === 'set' && fs.existsSync(${JSON.stringify(failingSet)})) { console.error('fixture set failed'); process.exit(7); }
if (command === 'create') {
 const data = Buffer.alloc(4096); data.writeBigUInt64LE(0x5353454755415244n,0);
 data.writeBigUInt64LE(policy === 'block' ? 6n : 5n,8); data.writeBigUInt64LE(policy === 'block' ? 2n : 1n,16);
 fs.writeFileSync(path,data,{flag:'wx',mode:0o600});
}
let data = fs.readFileSync(path), value = data.readBigUInt64LE(8);
if (command === 'set') { value = (((value >> 2n)+1n)<<2n) | (policy === 'block' ? 2n : 1n); data.writeBigUInt64LE(value,8); const fd=fs.openSync(path,'r+'); fs.writeSync(fd,data); fs.closeSync(fd); }
console.log(JSON.stringify({publishedGeneration:Number(value>>2n),policy:(value&3n)===2n?'block':'passthrough',warmupPolicy:data.readBigUInt64LE(16)===2n?'block':'passthrough',drained:false}));
`;
writeFileSync(join(native, "serve-sim-egress-control"), controller, { mode: 0o500 });
mock.module("../../capability-config", () => ({
  ...config,
  capabilityLoaderDir: () => source,
  capabilityLoaderPath: (device?: string) => {
    const enrolled = device ? readLaunchState(device)?.capabilities.egressGuard : undefined;
    return join(
      enrolled?.resident ? dirname(enrolled.dylib) : source,
      "libServeSimCapabilityLoader.dylib",
    );
  },
}));
const {
  prepareResidentEgress,
  bindResidentEgressBoot,
  checkResidentEgress,
  publishResidentEgressPolicy,
} = await import("../../egress-resources");
let state: ReturnType<typeof useTempStateDir>;
beforeEach(() => {
  state = useTempStateDir();
  writeFileSync(bootFile, "null");
  rmSync(failingSet, { force: true });
});
afterEach(() => state.restore());
afterAll(() => {
  mock.restore();
  rmSync(work, { recursive: true, force: true });
});

for (const mode of ["passthrough", "block"] as const) {
  test(`explicit ${mode} enrolls before boot and retains the same page through release`, async () => {
    await prepareResidentEgress(udid, mode);
    const cap = readLaunchState(udid)!.capabilities.egressGuard!;
    const page = cap.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
    const inode = lstatSync(page).ino;
    expect(cap.resident?.boot).toBeNull();
    expect(cap.resident?.warmupPolicy).toBe(mode);
    expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toContain(
      `startup\tprocess\t${cap.dylib}\tSERVE_SIM_EGRESS_POLICY_FILE=${page}`,
    );
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
    await bindResidentEgressBoot(udid);
    expect((await checkResidentEgress(udid)).resident?.boot).toEqual({
      pid: 1234,
      startedAt: "1720000000:42",
    });
    await publishResidentEgressPolicy(udid, mode === "block" ? "passthrough" : "block");
    expect(releaseLaunchState(udid, process.pid)).toBe(true);
    expect(lstatSync(page).ino).toBe(inode);
    expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toContain(
      `SERVE_SIM_EGRESS_POLICY_FILE=${page}`,
    );
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000001:42" }));
    await expect(checkResidentEgress(udid)).rejects.toThrow("boot changed");
    expect(existsSync(page)).toBe(true);
  });
}

test("already booted uninstrumented devices cannot be retrofitted", async () => {
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await expect(prepareResidentEgress(udid, "block")).rejects.toThrow("already-booted");
  expect(readdirSync(state.dir)).not.toContain(`launch-${udid}.json`);
});

test("failed preboot publication restores ordinary config and removes only the new child", async () => {
  const old = "user\t/camera.dylib\t\t0\n";
  writeFileSync(config.capabilityConfigPath(udid), old);
  const sentinel = join(state.dir, "sentinel");
  writeFileSync(sentinel, "preserve");
  mkdirSync(`${config.capabilityConfigPath(udid)}.${process.pid}.tmp`);
  await expect(prepareResidentEgress(udid, "block")).rejects.toThrow();
  expect(readFileSync(config.capabilityConfigPath(udid), "utf8")).toBe(old);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve");
  expect(readdirSync(state.dir).filter((name) => name.startsWith("egress-"))).toHaveLength(0);
});

test("policy failure and failed blocking cleanup preserve both errors and the mapping", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bindResidentEgressBoot(udid);
  const page = readLaunchState(udid)!.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const inode = lstatSync(page).ino;
  writeFileSync(failingSet, "fail");
  const error = await publishResidentEgressPolicy(udid, "block").catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toHaveLength(2);
  expect(
    (error as AggregateError).errors.every((cause: unknown) =>
      String(cause).includes("fixture set failed"),
    ),
  ).toBe(true);
  expect(lstatSync(page).ino).toBe(inode);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.resident).toBeDefined();
});

test("valid page and native identity cannot hide a missing startup record", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bindResidentEgressBoot(udid);
  rmSync(config.capabilityConfigPath(udid));
  await expect(checkResidentEgress(udid)).rejects.toThrow("startup record");
  expect(existsSync(config.capabilityConfigPath(udid))).toBe(false);
});
