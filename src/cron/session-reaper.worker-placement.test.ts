import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const mocks = vi.hoisted(() => ({
  deleteCronSessionViaGateway: vi.fn(),
  getMany: vi.fn(),
}));

vi.mock("./session-worker-placement.runtime.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: { getMany: mocks.getMany },
  }),
}));

vi.mock("./isolated-agent/session-cleanup.js", () => ({
  deleteCronSessionViaGateway: mocks.deleteCronSessionViaGateway,
}));

import { removeCronJobBaseSession } from "./session-reaper.js";

const { makeStorePath } = setupCronServiceSuite({
  prefix: "cron-reaper-worker-placement-",
});

describe("removeCronJobBaseSession worker placement", () => {
  beforeEach(() => {
    mocks.deleteCronSessionViaGateway.mockReset();
    mocks.getMany.mockReset();
  });

  it("delegates placement-owned base sessions to the gateway deletion lifecycle", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:placed-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "placed-session", updatedAt: 123 },
    );
    const existing = loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })!.entry;
    mocks.getMany.mockReturnValue(
      new Map([["placed-session", { sessionId: "placed-session", state: "active" }]]),
    );
    mocks.deleteCronSessionViaGateway.mockResolvedValue(true);

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "placed-job",
        sessionStorePath,
      }),
    ).resolves.toBe(true);

    expect(mocks.deleteCronSessionViaGateway).toHaveBeenCalledWith({
      agentSessionKey: sessionKey,
      sessionId: "placed-session",
      lifecycleRevision: existing.lifecycleRevision,
      sessionUpdatedAt: existing.updatedAt,
    });
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeDefined();
  });

  it("preserves placement ownership when the gateway rejects a raced deletion", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:raced-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "raced-session", updatedAt: 234 },
    );
    mocks.getMany.mockReturnValue(
      new Map([["raced-session", { sessionId: "raced-session", state: "active" }]]),
    );
    // A rejected Gateway delete can mean placement generation moved while an in-flight run
    // was settling. Direct store removal here would bypass that lifecycle fence.
    mocks.deleteCronSessionViaGateway.mockResolvedValue(false);

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "raced-job",
        sessionStorePath,
      }),
    ).resolves.toBe(false);

    expect(mocks.deleteCronSessionViaGateway).toHaveBeenCalledTimes(1);
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "raced-session" },
    });
  });

  it("keeps direct lifecycle removal for base sessions without a worker placement", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const sessionKey = "agent:main:cron:local-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "local-session", updatedAt: 456 },
    );
    mocks.getMany.mockReturnValue(new Map());

    await expect(
      removeCronJobBaseSession({
        agentId: "main",
        jobId: "local-job",
        sessionStorePath,
      }),
    ).resolves.toBe(true);

    expect(mocks.deleteCronSessionViaGateway).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
  });
});
