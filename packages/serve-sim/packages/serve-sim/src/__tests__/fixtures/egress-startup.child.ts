import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { useTempStateDir, withShimsAsync } from "../helpers";

const work = mkdtempSync("/tmp/serve-sim-egress-cli-");
const udid = "11111111-1111-4111-8111-111111111111";
let cli: string;
beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../../index.ts")],
    target: "node",
    outdir: join(work, "cli"),
    naming: "[name].mjs",
  });
  if (!result.success) throw new AggregateError(result.logs, "CLI test fixture bundle failed");
  cli = result.outputs[0]!.path;
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

for (const flags of [
  ["--enable", "egressGuard"],
  ["--disable", "egressGuard"],
]) {
  test(`${flags.join(" ")} is a required path, not best effort`, async () => {
    const state = useTempStateDir();
    const nativeLog = join(state.dir, "native-calls");
    try {
      await withShimsAsync(
        { xcrun: `#!/bin/sh\necho called >> '${nativeLog}'\nexit 99\n` },
        async () => {
          const child = Bun.spawn(
            ["node", cli, udid, ...flags, "--quiet", "--launch-app-identifier", "com.test.app"],
            { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
          );
          const [code, output, error] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code).toBe(1);
          expect(JSON.parse(output).error).toContain("egress enforcement is unavailable");
          expect(error).not.toContain("simulator-boot");
          expect(output).not.toContain('"url"');
          expect(existsSync(nativeLog)).toBe(false);
        },
      );
    } finally {
      state.restore();
    }
  });
}

test("conflicting egress choices reject before native calls", async () => {
  const state = useTempStateDir();
  try {
    const child = Bun.spawn(
      ["node", cli, udid, "--enable", "egressGuard", "--disable", "egressGuard", "--quiet"],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(1);
    expect(JSON.parse(out).error).toContain("not both");
  } finally {
    state.restore();
  }
});

test("no egress request retains the ordinary startup path", async () => {
  const state = useTempStateDir(),
    nativeLog = join(state.dir, "native-calls");
  try {
    await withShimsAsync(
      { xcrun: `#!/bin/sh\necho called >> '${nativeLog}'\nexit 99\n` },
      async () => {
        const child = Bun.spawn(["node", cli, udid, "--quiet"], {
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
        expect(code).toBe(1);
        expect(out).not.toContain("egress enforcement is unavailable");
        expect(existsSync(nativeLog)).toBe(true);
      },
    );
  } finally {
    state.restore();
  }
});
