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
import { readLaunchState, writeLaunchState } from "../../launch-state";
import { releaseLaunchState } from "../../launch-manager";
import { useTempStateDir, withShimsAsync } from "../helpers";

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
  bootPreparedResidentEgress,
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
    await bootFixture();
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
  await bootFixture();
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
  await bootFixture();
  rmSync(config.capabilityConfigPath(udid));
  await expect(checkResidentEgress(udid)).rejects.toThrow("startup record");
  expect(existsSync(config.capabilityConfigPath(udid))).toBe(false);
});

test("middleware observes a matching resident boot without issuing another boot", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const nativeLog = join(state.dir, "middleware-calls");
  const { withShimsAsync } = await import("../helpers");
  const { startDeviceInProcess } = await import("../../middleware");
  await withShimsAsync(
    {
      xcrun: `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(nativeLog)},JSON.stringify(args)+'\\n');
if(args[1]==='bootstatus') process.exit(42);
console.log(JSON.stringify({devices:{}}));
`,
    },
    async () => {
      expect(await startDeviceInProcess(udid, 12345, "/")).toContain(
        "failed to reach booted state",
      );
    },
  );
  const calls = readFileSync(nativeLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.some((args) => args[1] === "boot")).toBe(false);
  expect(calls.some((args) => args[1] === "bootstatus")).toBe(true);
  expect(
    calls.filter((args) => args[1] === "bootstatus").every((args) => !args.includes("-b")),
  ).toBe(true);
});

test("another live session cannot change resident policy", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const current = readLaunchState(udid)!;
  writeLaunchState(udid, { ...current, sessionPids: [process.ppid] });
  const page = current.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  await expect(publishResidentEgressPolicy(udid, "block")).rejects.toThrow("another session");
  expect(readFileSync(page)).toEqual(before);
});

test("a replacement boot during the wait cannot run callbacks or publish ready", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bootFixture();
  const { withShimsAsync } = await import("../helpers");
  const { startDeviceInProcess } = await import("../../middleware");
  const { stateFileForDevice } = await import("../../state");
  let applied = false;
  await withShimsAsync(
    {
      xcrun: `#!/usr/bin/env node
if(process.argv[3]==='bootstatus') require('fs').writeFileSync(${JSON.stringify(bootFile)},JSON.stringify({pid:1234,startedAt:'1720000001:42'}));
`,
    },
    async () => {
      await expect(
        startDeviceInProcess(udid, 12345, "/", undefined, undefined, async () => {
          applied = true;
        }),
      ).rejects.toThrow("boot changed");
    },
  );
  expect(applied).toBe(false);
  expect(existsSync(stateFileForDevice(udid))).toBe(false);
});

function bootShim(
  log: string,
  mode: "own" | "already-booted" | "replace" = "own",
  started = { pid: 5678, startedAt: "1720000000:42" },
) {
  return `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,insert:process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,config:process.env.SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG})+'\\n');
if(args[1]==='boot') {
 if(${JSON.stringify(mode)}==='already-booted') {console.error('Unable to boot device in current state: Booted');process.exit(1);}
 fs.writeFileSync(${JSON.stringify(bootFile)},JSON.stringify(${JSON.stringify(started)}));
} else if(args[1]==='bootstatus') {
 if(args.length!==3) process.exit(99);
 if(${JSON.stringify(mode)}==='replace') fs.writeFileSync(${JSON.stringify(bootFile)},JSON.stringify({pid:5678,startedAt:'1720000001:42'}));
} else process.exit(99);
`;
}

for (const mode of ["own", "already-booted", "replace"] as const) {
  test(`strict resident boot ${mode} preserves ownership and never bootstraps from a wait`, async () => {
    await prepareResidentEgress(udid, "block");
    const log = join(state.dir, "boot-calls");
    const guard = readLaunchState(udid)!.capabilities.egressGuard!;
    const inode = lstatSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!).ino;
    await withShimsAsync({ xcrun: bootShim(log, mode) }, async () => {
      if (mode === "own") await bootPreparedResidentEgress(udid);
      else
        await expect(bootPreparedResidentEgress(udid)).rejects.toThrow(
          mode === "replace" ? "boot changed" : "Booted",
        );
    });
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0].args).toEqual(["simctl", "boot", udid]);
    expect(calls[0].insert.split(":")).toContain(guard.dylib);
    expect(calls[0].config).toBe(config.capabilityConfigPath(udid));
    if (mode === "already-booted") expect(calls).toHaveLength(1);
    else expect(calls[1].args).toEqual(["simctl", "bootstatus", udid]);
    expect(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot).toEqual(
      mode === "own" ? { pid: 5678, startedAt: "1720000000:42" } : null,
    );
    expect(lstatSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!).ino).toBe(inode);
  });
}

test("a foreign boot after preparation is refused before native boot or binding", async () => {
  await prepareResidentEgress(udid, "block");
  writeFileSync(bootFile, JSON.stringify({ pid: 9000, startedAt: "1720000000:42" }));
  const log = join(state.dir, "boot-calls");
  await withShimsAsync({ xcrun: bootShim(log) }, async () => {
    await expect(bootPreparedResidentEgress(udid)).rejects.toThrow("already-booted");
  });
  expect(existsSync(log)).toBe(false);
  expect(readLaunchState(udid)!.capabilities.egressGuard!.resident!.boot).toBeNull();
});

test("cancellation after starting a resident boot retains unbound assets and stops readiness", async () => {
  await prepareResidentEgress(udid, "block");
  const log = join(state.dir, "boot-calls");
  let calls = 0;
  await withShimsAsync({ xcrun: bootShim(log) }, async () => {
    await expect(
      bootPreparedResidentEgress(udid, () => {
        if (++calls === 2) throw new Error("startup cancelled");
      }),
    ).rejects.toThrow("startup cancelled");
  });
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  const guard = readLaunchState(udid)!.capabilities.egressGuard!;
  expect(guard.resident!.boot).toBeNull();
  expect(existsSync(guard.env!.SERVE_SIM_EGRESS_POLICY_FILE!)).toBe(true);
});

async function bootFixture() {
  const started = JSON.parse(readFileSync(bootFile, "utf8"));
  writeFileSync(bootFile, "null");
  await withShimsAsync(
    { xcrun: bootShim(join(state.dir, "fixture-boot-calls"), "own", started) },
    () => bootPreparedResidentEgress(udid),
  );
}
