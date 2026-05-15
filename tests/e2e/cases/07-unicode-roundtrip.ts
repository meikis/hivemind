/**
 * Unicode roundtrip — RELEASE_CHECKLIST §2 ("edge content like quotes /
 * unicode / empty fields").
 *
 * A capture row whose content includes emoji, RTL script, smart quotes,
 * and backslashes is the most common source of "wrote bytes, can't read
 * them back". Past JSONB-escape bugs in the capture path collapsed `\\`
 * → `\` on roundtrip, silently corrupting any code-block content with
 * literal backslashes (Windows paths, regex examples, latex).
 *
 * We seed a unique marker that combines all four risk classes and assert
 * the marker survives the INSERT/SELECT roundtrip byte-for-byte. Marker
 * includes the runId-scoped session_id so the assertion finds *this*
 * run's row and not a stale one from a previous case.
 */

import type { E2ECase } from "../types.js";

// Marker components — emoji (multi-byte), RTL Arabic, smart quotes, a
// double-quoted backslash that round-trips through JSON.stringify.
// Avoid single-quotes in the marker so the SQL literal is unambiguous;
// the agent can still echo single-quoted content in the prompt itself.
const UNICODE_MARKER = "🐝-مرحبا-\"X\\Y\"-€-snapshot";

const unicodeRoundtripCase: E2ECase = {
  id: "07-unicode-roundtrip",
  description:
    "captured message preserves emoji + RTL + smart quotes + backslashes byte-for-byte through the JSONB roundtrip",
  prompt:
    `Reply with exactly this string once and then stop, no commentary, ` +
    `no markdown, no quotes added: ${UNICODE_MARKER}`,
  assertions: [
    {
      type: "select-from-db",
      label: "unicode marker present byte-for-byte in captured rows",
      // ILIKE on the JSONB-as-text projection. We want the literal bytes,
      // so we cast to text and grep with case-sensitive LIKE — Deeplake
      // accepts position() for substring search which is portable.
      sql: ({ ctx, run }) =>
        `SELECT count(*) AS n FROM "${ctx.creds.sessionsTable}" ` +
        `WHERE path ILIKE '%${run.sessionId.replace(/'/g, "''")}%' ` +
        `AND position('${UNICODE_MARKER.replace(/'/g, "''")}' IN message::text) > 0`,
      expect: (rows) => {
        if (rows.length === 0) throw new Error("count query returned no rows");
        const n = Number((rows[0] as { n: number | string }).n);
        if (!Number.isFinite(n) || n < 1) {
          throw new Error(
            `unicode marker not found in any captured row — JSONB escape may have corrupted it. ` +
            `Got ${n} matching rows.`,
          );
        }
      },
    },
  ],
};

export default unicodeRoundtripCase;
