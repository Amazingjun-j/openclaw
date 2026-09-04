import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("oxfmt oracle", () => {
  it("prints exact formatting for the cron gateway proof", () => {
    const sourcePath = "src/cron/session-reaper.worker-placement.e2e.test.ts";
    const oraclePath = "src/cron/.session-reaper.worker-placement.e2e.oracle.ts";
    copyFileSync(sourcePath, oraclePath);
    try {
      execFileSync("pnpm", ["exec", "oxfmt", "--write", "--threads=1", oraclePath], {
        encoding: "utf8",
      });
      const source = readFileSync(sourcePath, "utf8");
      const formatted = readFileSync(oraclePath, "utf8");
      console.log(`OXFMT_ORACLE_START\n${formatted}OXFMT_ORACLE_END`);
      expect(formatted).toBe(source);
    } finally {
      rmSync(oraclePath, { force: true });
    }
  });
});
