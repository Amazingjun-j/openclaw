import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "../gateway/gateway.test-support.js";
import { getGatewayE2ePortBlock } from "../gateway/test-helpers.e2e.js";
import { startGatewayServer } from "../gateway/server.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { removeCronJobBaseSession } from "./session-reaper.js";

describe("removeCronJobBaseSession gateway worker-placement lifecycle", () => {
  let restoreEnv: (() => void) | undefined;
  let tempHome: string | undefined;

  beforeEach(() => {
    resetGatewayTestState();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    resetGatewayTestState();
    if (tempHome) {
      await removeGatewayTempHome(tempHome);
      tempHome = undefined;
    }
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("drains active work and removes both the cron session and placement through the real gateway", async () => {
    const setup = await setupGatewayTempHome({
      prefix: "openclaw-cron-placement-gateway-",
      minimalGateway: true,
    });
    tempHome = setup.tempHome;
    restoreEnv = setup.envSnapshot.restore;

    const port = await getGatewayE2ePortBlock();
    const token = "cron-placement-gateway-test-token";
    process.env.OPENCLAW_GATEWAY_PORT = String(port);
    process.env.OPENCLAW_GATEWAY_TOKEN = token;

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    const agentId = "main";
    const jobId = "gateway-proof-job";
    const sessionKey = `agent:${agentId}:cron:${jobId}`;
    const sessionId = "gateway-proof-session";
    const sessionStorePath = resolveDefaultSessionStorePath(agentId);
    const placementStore = createWorkerSessionPlacementStore();
    const events: string[] = [];
    let releaseAdmission = () => {};
    let claimReleased = false;

    try {
      await replaceSessionEntry(
        { agentId, storePath: sessionStorePath, sessionKey },
        { sessionId, updatedAt: Date.now() },
      );
      const claim = placementStore.claimTurn({
        sessionId,
        agentId,
        sessionKey,
        owner: { kind: "local" },
        claimId: `${sessionId}-claim`,
        runId: `${sessionId}-run`,
      });
      const admission = await beginSessionWorkAdmission({
        scope: sessionStorePath,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
        onInterrupt: () => {
          events.push("admission:interrupt");
          placementStore.releaseTurn(claim);
          claimReleased = true;
          events.push("claim:released");
          releaseAdmission();
        },
      });
      releaseAdmission = admission.release;

      expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })?.entry.sessionId).toBe(
        sessionId,
      );
      expect(placementStore.get(sessionId)?.turnClaim?.claimId).toBe(`${sessionId}-claim`);

      await expect(
        removeCronJobBaseSession({ agentId, jobId, sessionStorePath }),
      ).resolves.toBe(true);

      expect(events).toEqual(["admission:interrupt", "claim:released"]);
      expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
      expect(placementStore.get(sessionId)).toBeUndefined();

      if (!claimReleased) {
        placementStore.releaseTurn(claim);
      }
      admission.release();
    } finally {
      await server.close({ reason: "cron placement lifecycle proof complete" });
    }
  });
});
