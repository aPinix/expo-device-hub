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
import { useTempStateDir } from "../helpers";

const work = mkdtempSync("/tmp/serve-sim-egress-resources-");
const source = join(work, "capability-loader"),
  native = join(work, "egress-guard");
const bootFile = join(work, "boot.json");
const failingSet = join(work, "failing-set");
const pauseBoot = join(work, "pause-boot"),
  enteredBoot = join(work, "entered-boot");
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
  `#!/usr/bin/env node
const fs=require('fs');
async function main() {
 if(fs.existsSync(${JSON.stringify(pauseBoot)})) {
  fs.writeFileSync(${JSON.stringify(enteredBoot)},'entered');
  while(fs.existsSync(${JSON.stringify(pauseBoot)})) await new Promise(r=>setTimeout(r,5));
 }
 console.log(fs.readFileSync(${JSON.stringify(bootFile)},'utf8'));
}
main();
`,
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
  rmSync(pauseBoot, { force: true });
  rmSync(enteredBoot, { force: true });
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

test("middleware observes a matching resident boot without issuing another boot", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bindResidentEgressBoot(udid);
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
  await bindResidentEgressBoot(udid);
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
  await bindResidentEgressBoot(udid);
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

// Exercise the existing private owner channel, with only the boot/controller executables modeled.
async function ownerFixture(
  run: (value: {
    adopt(policy?: "block" | "passthrough"): Promise<unknown>;
    configured(): number;
    ownerFile: string;
    raw(policy?: "block" | "passthrough"): Promise<Record<string, unknown>>;
    disconnectDuringPreflight(): Promise<void>;
  }) => Promise<void>,
) {
  const { resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { adoptSession, bootSession, sessionEnvironment, sessionOwnerFile, startSessionOwner } =
    await import("../../session-owner");
  const { inProcessServeSimState, stateDir, writeServeSimState } = await import("../../state");
  const { DEFAULT_STREAM_ENCODER_SETTINGS } = await import("../../stream-settings");
  let configured = 0;
  const identity = {
    version: "fixture",
    pid: process.pid,
    device: udid,
    bootSession: bootSession(),
    host: "127.0.0.1",
    port: 3200,
    stateDirectory: resolve(stateDir()),
    temporaryDirectory: resolve(tmpdir()),
    environment: sessionEnvironment(),
  };
  const owner = await startSessionOwner(
    udid,
    () => identity,
    async () => {
      configured++;
    },
  );
  writeServeSimState({ ...inProcessServeSimState(udid, 3200), token: "preview-token" });
  const directory = JSON.parse(readFileSync(sessionOwnerFile(udid), "utf8")).directory;
  const secret = readFileSync(join(directory, "authority"), "utf8");
  const configuration = (egressPolicy?: "block" | "passthrough") => ({
    stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
    corsOrigins: [],
    frameAncestors: [],
    disableShare: false,
    networkCapture: false,
    networkCaptureFields: [],
    egressPolicy,
  });
  const { createConnection } = await import("node:net");
  const connect = () => createConnection(join(directory, "control.sock"));
  const body = (policy?: "block" | "passthrough") =>
    JSON.stringify({
      secret,
      method: "configure",
      identity,
      configuration: configuration(policy),
    }) + "\n";
  try {
    await run({
      ownerFile: sessionOwnerFile(udid),
      raw: (policy) =>
        new Promise((resolve, reject) => {
          const socket = connect();
          let data = "";
          socket.setTimeout(3000, () => socket.destroy(new Error("owner fixture timeout")));
          socket.on("error", reject);
          socket.once("connect", () => socket.write(body(policy)));
          socket.on("data", (chunk) => {
            data += chunk;
            if (data.includes("\n")) {
              const response = JSON.parse(data);
              socket.once("close", () => resolve(response));
              socket.destroy();
            }
          });
        }),
      disconnectDuringPreflight: async () => {
        writeFileSync(pauseBoot, "pause");
        const socket = connect();
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.once("connect", () => {
              socket.write(body("block"));
              resolve();
            });
          });
          const deadline = Date.now() + 3000;
          while (!existsSync(enteredBoot)) {
            if (Date.now() > deadline) throw new Error("preflight did not enter boot check");
            await new Promise((r) => setTimeout(r, 5));
          }
          const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
          socket.destroy();
          await closed;
          // Deliver the peer close before allowing its blocked preflight to resume.
          await new Promise((r) => setTimeout(r, 20));
        } finally {
          socket.destroy();
          rmSync(pauseBoot, { force: true });
        }
        const { withLaunchStateLock } = await import("../../launch-state-lock");
        await withLaunchStateLock(udid, async () => {});
      },
      configured: () => configured,
      adopt: (egressPolicy) =>
        adoptSession(udid, "fixture", "127.0.0.1", 3200, {
          stream: { transport: "webrtc", codec: "h264", ...DEFAULT_STREAM_ENCODER_SETTINGS },
          corsOrigins: [],
          frameAncestors: [],
          disableShare: false,
          networkCapture: false,
          networkCaptureFields: [],
          egressPolicy,
        }),
    });
  } finally {
    owner.close();
  }
}

for (const policy of ["block", "passthrough"] as const) {
  test(`private ${policy} adoption consumes a compatible claim but cannot admit unproved enforcement`, async () => {
    await prepareResidentEgress(udid, "passthrough");
    writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
    await bindResidentEgressBoot(udid);
    const cap = readLaunchState(udid)!.capabilities.egressGuard!;
    const page = cap.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
    const pageBefore = readFileSync(page),
      configBefore = readFileSync(config.capabilityConfigPath(udid));
    await ownerFixture(async ({ adopt, configured, ownerFile, raw }) => {
      await expect(adopt()).rejects.toThrow("explicit");
      expect(await raw()).toEqual({ ok: false, error: "session_configuration_failed" });
      expect(existsSync(ownerFile)).toBe(true);
      await expect(adopt(policy)).rejects.toThrow("session_configuration_failed");
      expect(configured()).toBe(0);
      expect(existsSync(ownerFile)).toBe(false);
      await expect(adopt(policy)).rejects.toThrow();
    });
    expect(readFileSync(page)).toEqual(pageBefore);
    expect(readFileSync(config.capabilityConfigPath(udid))).toEqual(configBefore);
  });
}

test("a changed native boot rejects private adoption before consuming authority", async () => {
  await prepareResidentEgress(udid, "passthrough");
  const boot = { pid: 1234, startedAt: "1720000000:42" };
  writeFileSync(bootFile, JSON.stringify(boot));
  await bindResidentEgressBoot(udid);
  await ownerFixture(async ({ adopt, configured, ownerFile }) => {
    writeFileSync(bootFile, JSON.stringify({ ...boot, startedAt: "1720000001:42" }));
    await expect(adopt("block")).rejects.toThrow("boot changed");
    expect(existsSync(ownerFile)).toBe(true);
    expect(configured()).toBe(0);
    writeFileSync(bootFile, JSON.stringify(boot));
    await expect(adopt("block")).rejects.toThrow("session_configuration_failed");
    expect(existsSync(ownerFile)).toBe(false);
  });
});

test("an ordinary uninstrumented owner rejects egress without consuming its normal claim", async () => {
  await ownerFixture(async ({ adopt, configured, ownerFile }) => {
    await expect(adopt("block")).rejects.toThrow("No compatible resident");
    expect(existsSync(ownerFile)).toBe(true);
    await adopt();
    expect(configured()).toBe(1);
    expect(existsSync(ownerFile)).toBe(false);
  });
});

test("disconnect during resident compatibility does not consume a claim or publish policy", async () => {
  await prepareResidentEgress(udid, "passthrough");
  writeFileSync(bootFile, JSON.stringify({ pid: 1234, startedAt: "1720000000:42" }));
  await bindResidentEgressBoot(udid);
  const page = readLaunchState(udid)!.capabilities.egressGuard!.env!.SERVE_SIM_EGRESS_POLICY_FILE!;
  const before = readFileSync(page);
  await ownerFixture(async ({ disconnectDuringPreflight, ownerFile, configured, adopt }) => {
    await disconnectDuringPreflight();
    expect(existsSync(ownerFile)).toBe(true);
    expect(configured()).toBe(0);
    expect(readFileSync(page)).toEqual(before);
    await expect(adopt("block")).rejects.toThrow("session_configuration_failed");
    expect(existsSync(ownerFile)).toBe(false);
  });
});
