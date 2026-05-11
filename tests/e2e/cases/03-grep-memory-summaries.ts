/**
 * grep over ~/.deeplake/memory/summaries/ routes through the SQL fast-path.
 *
 * The agent is told to grep for a sentinel string the harness seeds into
 * the memory table. With the grep-direct intercept wired, the hook
 * issues one SQL query against the memory table and returns matching
 * rows; without it, grep walks the real filesystem and finds nothing
 * because the mount is virtual.
 *
 * setup() inserts a deterministic memory row keyed on this case's
 * session_id, so we don't depend on any pre-existing test data and the
 * assertion has a stable, unique sentinel to match against.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { E2ECase } from "../types.js";

const SENTINEL = "HIVEMIND_E2E_GREP_SENTINEL_42";

export const grepMemorySummariesCase: E2ECase = {
  id: "03-grep-memory-summaries",
  description:
    "agent shells grep over ~/.deeplake/memory/summaries/ and the SQL fast-path returns the sentinel row",
  prompt:
    `Run exactly this bash command and show me its full output:\n` +
    `grep -r ${SENTINEL} ~/.deeplake/memory/summaries/`,
  async setup(ctx) {
    const memoryApi = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      ctx.creds.memoryTable,
    );
    // Insert a deterministic memory row with our sentinel in the message
    // body. Path embeds the session_id so cleanup sweeps it. Schema
    // matches what the capture hook would produce — minimal fields only.
    const path = `/summaries/e2e/${ctx.sessionId}.md`;
    const message = JSON.stringify({
      type: "summary",
      session_id: ctx.sessionId,
      content: `## E2E grep sentinel\n\nMarker: ${SENTINEL}\n`,
    }).replace(/'/g, "''");
    await memoryApi.query(
      `INSERT INTO "${ctx.creds.memoryTable}" ` +
      `(id, path, filename, message, author, size_bytes, project, description, agent, creation_date, last_update_date) ` +
      `VALUES (gen_random_uuid(), '${path}', '${ctx.sessionId}.md', '${message}'::jsonb, ` +
      `'e2e', ${Buffer.byteLength(message, "utf-8")}, 'e2e', 'grep-sentinel', '${ctx.agent}', ` +
      `CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    );
  },
  assertions: [
    {
      type: "hook-log-contains",
      substring: "direct grep",
      label: "grep-direct intercept fired",
    },
    {
      type: "stdout-contains",
      substring: SENTINEL,
      label: "agent received the sentinel row from the SQL fast-path",
    },
  ],
};
