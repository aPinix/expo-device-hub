import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

export interface PhysicalAppleDevice {
  udid: string;
  name: string;
  model: string;
  osVersion: string;
  connected: boolean;
  transport: string | null;
}

/** Xcode 27's nondeprecated CoreDevice schema includes both iPhone and iPad. */
export function parsePhysicalDevices(stdout: string): PhysicalAppleDevice[] {
  const data = JSON.parse(stdout);
  if (
    data?.info?.outcome !== "success" ||
    !Number.isInteger(data.info.jsonVersion) ||
    data.info.jsonVersion < 5 ||
    !Array.isArray(data?.result?.devices)
  ) {
    throw new Error("Physical iOS devices require Xcode 27 or later.");
  }
  return data.result.devices.flatMap((entry: any) => {
    const { hardware, state, software, connection } = entry?.properties ?? {};
    if (
      hardware?.reality !== "physical" ||
      hardware.platform !== "iOS" ||
      !/^(iPhone|iPad)/.test(hardware.productType ?? "")
    )
      return [];
    if (typeof hardware.udid !== "string" || typeof state?.name !== "string") return [];
    return [
      {
        udid: hardware.udid,
        name: state.name,
        model:
          typeof hardware.marketingName === "string"
            ? hardware.marketingName
            : hardware.productType,
        osVersion: software?.osVersionNumber?.stringValue ?? "",
        connected: connection?.state === "connected",
        transport: connection?.transportType ?? null,
      },
    ];
  });
}

let lastDiscovery: { devices: PhysicalAppleDevice[]; at: number } | undefined;

export async function listPhysicalDevices(): Promise<AppleUtilsResult<PhysicalAppleDevice[]>> {
  if (process.platform !== "darwin") return result([]);
  try {
    const { stdout } = await promisify(execFile)(
      "xcrun",
      [
        "devicectl",
        "list",
        "devices",
        "--quiet",
        "--timeout",
        "10",
        "--omit-deprecated-fields-in-json",
        "--json-output",
        "-",
      ],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const devices = parsePhysicalDevices(stdout);
    lastDiscovery = { devices, at: Date.now() };
    return result(devices);
  } catch (error) {
    // A transient Xcode timeout should not tear down a working preview. Successful
    // discovery still removes disconnected devices immediately.
    const devices =
      lastDiscovery && Date.now() - lastDiscovery.at < 60_000 ? lastDiscovery.devices : [];
    return result(devices, reportError("[apple-utils] Physical iOS discovery failed:", error));
  }
}
