import { describe, expect, test } from "bun:test";
import { listDevices } from "../list-devices";
import { result } from "../errors";

const missingAvdmanager = { message: "avdmanager unavailable", error: new Error("ENOENT") };
const phone = "test-samsung";

describe("partial device discovery", () => {
  test("keeps a connected Samsung when Android command-line tools are missing", async () => {
    const listed = await listDevices({
      runAvdmanagerListAvd: async () => result(null, missingAvdmanager),
      runAdbDevices: async () =>
        result(`List of devices attached\n${phone} device model:SM_S731U1\n`),
      runAdbGetprop: async () =>
        result("[ro.product.model]: [SM-S731U1]\n[ro.build.version.release]: [17]"),
    });
    expect(listed.value).toMatchObject([{ type: "device", serial: phone, booted: true }]);
    expect(listed.error).toBe(missingAvdmanager);
  });

  test("one disconnected device does not hide another connected phone", async () => {
    const failure = { message: "getprop failed", error: new Error("device offline") };
    const listed = await listDevices({
      runAvdmanagerListAvd: async () => result(null),
      runAdbDevices: async () =>
        result(`List of devices attached\noffline-phone device\n${phone} device\n`),
      runAdbGetprop: async (_adb, serial) =>
        serial === phone ? result("[ro.product.model]: [SM-S731U1]") : result(null, failure),
    });
    expect(listed.value.map((device) => device.serial)).toEqual([phone]);
    expect(listed.error).toBe(failure);
  });
});
