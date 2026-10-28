import { expect, test } from "bun:test";
import { parsePhysicalDevices } from "../physical-devices";

test("discovers iPhones and iPads without treating remembered devices as connected", () => {
  const device = (productType: string, state: string) => ({
    properties: {
      hardware: {
        reality: "physical",
        platform: "iOS",
        productType,
        udid: productType,
        marketingName: productType,
      },
      state: { name: productType },
      software: { osVersionNumber: { stringValue: "27.2" } },
      connection: { state, transportType: "wired" },
    },
  });
  const devices = parsePhysicalDevices(
    JSON.stringify({
      info: { outcome: "success", jsonVersion: 5 },
      result: {
        devices: [
          device("iPhone17,1", "connected"),
          device("iPad16,6", "connected"),
          device("iPhone16,1", "disconnected"),
          device("Watch7,1", "connected"),
        ],
      },
    }),
  );
  expect(devices.map(({ udid, connected }) => [udid, connected])).toEqual([
    ["iPhone17,1", true],
    ["iPad16,6", true],
    ["iPhone16,1", false],
  ]);
});

test("rejects unsupported discovery schema and failed invocations", () => {
  expect(() =>
    parsePhysicalDevices('{"info":{"outcome":"success","jsonVersion":4},"result":{"devices":[]}}'),
  ).toThrow("Xcode 27");
  expect(() => parsePhysicalDevices("not json")).toThrow();
});
