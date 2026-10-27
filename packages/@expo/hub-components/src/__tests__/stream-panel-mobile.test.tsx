import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceClient } from "@expo/hub-client";
import { StreamPanel } from "../dashboard/StreamPanel";

function render(width: number) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: width,
      innerHeight: 667,
      visualViewport: { width, height: 667, offsetLeft: 0, offsetTop: 0 },
      matchMedia: () => ({ matches: true }),
    },
  });
  try {
    return renderToStaticMarkup(
      <StreamPanel
        device={{
          id: "phone",
          name: "Test phone",
          platform: "ios",
          version: "iOS 26.5",
          booted: true,
          physical: false,
          supported: true,
          deviceFrame: null,
        }}
        client={
          {
            status: "streaming",
            screen: { width: 375, height: 667 },
            deviceSettings: { appearance: "light" },
            deviceSettingsStatus: "ready",
            deviceSettingsPending: new Set(),
            capabilities: { clipboard: false },
            sendKeyEvents: () => {},
          } as unknown as DeviceClient
        }
        DeviceScreen={() => <div>Stream</div>}
        displayScreen={(screen) => screen ?? null}
        onToggleInspector={() => {}}
      />,
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("mobile hides the title and offers viewer keyboard and full screen controls", () => {
  const html = render(375);
  expect(html).not.toContain("Test phone");
  expect(html).toContain('aria-label="Full screen"');
  expect(html).toContain('aria-label="Keyboard"');
  expect(html).toContain('aria-label="Toggle inspector"');
  expect(html).toContain("font-size:16px");
});

test("desktop keeps its title and original controls", () => {
  const html = render(1280);
  expect(html).toContain("Test phone");
  expect(html).not.toContain('aria-label="Full screen"');
  expect(html).toContain('aria-label="Home"');
  expect(html).not.toContain('aria-label="Toggle inspector"');
});
