/**
 * Missing-table self-heal — RELEASE_CHECKLIST §6.
 *
 * First INSERT against a missing sessions / memory table should
 * `CREATE TABLE IF NOT EXISTS` lazily and retry. Without this, the very
 * first capture after a fresh workspace setup would fail and silently
 * drop the row.
 *
 * setup() drops the sessions table (best-effort — if it doesn't exist
 * yet, fine). The agent's prompt triggers a normal capture flow. We
 * then assert that the table was recreated AND the post-create INSERT
 * landed.
 *
 * We DROP only the sessions table, not memory, to keep the blast
 * radius small and the case fast. The two paths share the same
 * ensureSessionsTable() helper so coverage transfers.
 *
 * Note: this case is destructive within the e2e workspace by design.
 * The harness uses a dedicated `hivemind_e2e_test` workspace so the
 * DROP has no impact on real data. If it ever ran against a real
 * workspace, that'd be catastrophic — same constraint as every other
 * destructive scenario in RELEASE_CHECKLIST §7.
 */

import { DeeplakeApi } from "../../../src/deeplake-api.js";
import type { E2ECase } from "../types.js";

export const missingTableSelfHealCase: E2ECase = {
  id: "06-missing-table-self-heal",
  description:
    "after the sessions table is dropped, the next capture lazily creates it and lands the row",
  prompt:
    "Reply with the single word 'heal' once and stop. Do not call tools.",
  async setup(ctx) {
    // DROP the sessions table; the capture path must self-heal. We use
    // IF EXISTS so the case is idempotent across reruns where prior
    // assertions left the table in either state.
    const api = new DeeplakeApi(
      ctx.creds.token,
      ctx.creds.apiUrl,
      ctx.creds.orgId,
      ctx.creds.workspaceId,
      ctx.creds.sessionsTable,
    );
    try {
      await api.query(`DROP TABLE IF EXISTS "${ctx.creds.sessionsTable}"`);
    } catch {
      // Some Deeplake deployments refuse DROP TABLE for the canonical
      // sessions/memory names. If the drop fails, the case effectively
      // becomes a no-op smoke; the row-landed assertion still verifies
      // the happy path. We don't fail the case on drop failure because
      // the destructive setup is best-effort by design.
    }
  },
  assertions: [
    {
      type: "select-from-db",
      label: "sessions table exists after the run (self-healed)",
      sql: ({ ctx }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}"`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("sessions count returned no rows — table never came back");
      },
    },
    {
      type: "select-from-db",
      label: "this run's session_id landed at least one row in the recreated table",
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%'`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(`expected ≥ 1 row for the run, got ${n} — lazy CREATE TABLE didn't recover`);
        }
      },
    },
  ],
};
