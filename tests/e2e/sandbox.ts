/**
 * Per-case filesystem sandbox.
 *
 * For each (case, agent) tuple we want:
 *   1. A fresh HOME that no other case can read or write
 *   2. A `~/.deeplake/credentials.json` pointing at the e2e test workspace
 *   3. The agent's hivemind bundle deposited at the agent-specific path
 *      under that HOME (or a session-only plugin flag — see claude-code).
 *
 * We DO NOT share HOMEs across cases even within a single agent. Reasons:
 *   - The hivemind hook writes ~/.deeplake/hook-debug.log; reusing the
 *     HOME means cross-case log contamination breaks the
 *     `hook-log-contains` assertion's "occurred during MY case" guarantee.
 *   - Some agents cache plugin state by content-hash; a stale cache from
 *     case 1 has been observed to mask a case-2 install failure.
 *
 * Cleanup is rm -rf of the tmp HOME at the end of each case. The caller
 * may pass `keepSandbox: true` to leave it on disk for debugging.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, TestCredentials } from "./types.js";

export interface Sandbox {
  home: string;
  /** Delete the sandbox. Idempotent. */
  destroy: () => void;
}

/**
 * Create a fresh tmp HOME and seed it with the e2e workspace credentials.
 *
 * Returns a {home, destroy} pair. Caller is responsible for calling
 * destroy() in a finally block (or for passing `keepSandbox` and cleaning
 * up out-of-band).
 */
export function createSandbox(agent: AgentId, creds: TestCredentials): Sandbox {
  const home = mkdtempSync(join(tmpdir(), `hm-e2e-${agent}-`));
  const deeplakeDir = join(home, ".deeplake");
  mkdirSync(deeplakeDir, { recursive: true, mode: 0o700 });
  // saveCredentials() in src/commands/auth-creds.ts is lazy on HOME, but
  // we write the file directly here so we don't depend on any module's
  // current process.env.HOME at write time. credentials.json's `savedAt`
  // is a free-form ISO string per the type.
  const payload = {
    token: creds.token,
    orgId: creds.orgId,
    orgName: creds.orgName,
    workspaceId: creds.workspaceId,
    apiUrl: creds.apiUrl,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(deeplakeDir, "credentials.json"),
    JSON.stringify(payload, null, 2),
    { mode: 0o600 },
  );
  return {
    home,
    destroy: () => {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Best-effort. A leftover tmp dir is annoying but never blocks a run.
      }
    },
  };
}

/**
 * Build a deterministic session_id for this (case, agent, runId) tuple.
 *
 * Embeds the runId so that cleanup queries can sweep all rows from one
 * harness invocation in a single statement, and the agent label so a
 * single case×agent failure can be inspected without grepping every row.
 * Prefix `e2e-` makes the daily cron pattern (`WHERE agent ILIKE 'e2e-%'`)
 * tractable in case something escapes the per-run cleanup.
 */
export function buildSessionId(caseId: string, agent: AgentId, runId: string): string {
  return `e2e-${runId}-${caseId}-${agent}`;
}
