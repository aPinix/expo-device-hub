import { expect, test } from "bun:test";
import { runChildSuite } from "./fixtures/run-child-suite";

test("explicit egress startup fails before boot, app actions or ready when enforcement is unavailable", async () => {
  const result = await runChildSuite("egress-startup.child.ts");
  expect(result.exitCode, result.output).toBe(0);
}, 60_000);
