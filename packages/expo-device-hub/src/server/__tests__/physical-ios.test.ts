import { expect, test } from "bun:test";
import { createPhysicalIosHandler, type PhysicalCapture } from "../physical-ios";

function fixture() {
  let closed = 0;
  let touches = 0;
  let generation = 1;
  const capture: PhysicalCapture = {
    read: async () => ({
      generation,
      frames: [{ key: true, timestamp: 0, data: Buffer.from([1, 2]) }],
      dropped: 0,
    }),
    touch: async (samples) => {
      expect(samples[0]).toMatchObject({ x: 50, y: 100, width: 100, height: 200 });
      touches++;
    },
    requestKeyframe: () => {
      generation++;
    },
    close: async () => {
      closed++;
    },
  };
  const handler = createPhysicalIosHandler(
    async () => capture,
    async () => ({
      value: [
        {
          udid: "phone",
          name: "iPhone",
          model: "iPhone",
          osVersion: "27",
          connected: true,
          transport: "wired",
        },
      ],
      error: null,
    }),
  );
  const call = (operation: string, body: object, headers = {}) =>
    handler.handle(
      new Request(`http://localhost/api/ios-device/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { handler, call, counts: () => ({ closed, touches }) };
}

test("requires a displayed generation, validates coordinates, and closes only its session", async () => {
  const { handler, call, counts } = fixture();
  try {
    const { session } = await (await call("open", { device: "phone" })).json();
    const input = {
      session,
      generation: 1,
      samples: [{ phase: 0, x: 0.5, y: 0.5, width: 100, height: 200 }],
    };
    expect((await call("input", input)).status).toBe(409);
    const batch = await (await call("read", { session })).json();
    expect(batch.frames[0].data).toBe("AQI=");
    expect(
      (await call("input", { ...input, samples: [{ ...input.samples[0], x: 2 }] })).status,
    ).toBe(400);
    expect((await call("input", input)).status).toBe(200);
    expect(counts().touches).toBe(1);
    await call("reset", { session });
    expect((await call("input", input)).status).toBe(409);
    await call("close", { session });
    expect(counts().closed).toBe(1);
    expect((await call("read", { session })).status).toBe(410);
  } finally {
    await handler.dispose();
  }
});

test("rejects unconnected devices, foreign origins, oversized bodies, and excess captures", async () => {
  const { handler, call, counts } = fixture();
  try {
    expect((await call("open", { device: "missing" })).status).toBe(409);
    expect(
      (await call("open", { device: "phone" }, { origin: "https://example.com" })).status,
    ).toBe(403);
    expect((await call("open", { device: "x".repeat(40_000) })).status).toBe(413);
    for (let i = 0; i < 4; i++) expect((await call("open", { device: "phone" })).status).toBe(200);
    expect((await call("open", { device: "phone" })).status).toBe(429);
  } finally {
    await handler.dispose();
  }
  expect(counts().closed).toBe(4);
});
