/**
 * Resume brief — the signed-in payoff that the first-run signup brief
 * promises. Where cold-start-brief.ts fires ONCE for anonymous users off
 * local jsonl, this fires every session for a logged-in user and answers
 * "where did I leave off?" from their captured Hivemind summaries.
 *
 * It is the gated half of the pair: it only ever runs when creds are
 * present (the caller passes null-or-creds). No creds → never runs → no
 * payoff. That IS the gate.
 *
 * Source: the `memory` table (one row per session summary). We pull the last
 * few summaries for the CURRENT project by THIS user and surface the most
 * recent unfinished work as a "pick up where you left off" pointer.
 *
 * Resolution (newest-first over the last LOOKBACK summaries):
 *   1. First session with real open work → "you left off here: <next step>"
 *      + a pick-it-up call to action.
 *   2. Summaries exist but every recent session wrapped clean → a brief with
 *      NO call to action ("wrapped up clean, nothing pending") — we don't
 *      invent an action that isn't there.
 *   3. No summaries for this project at all → null; the caller renders the
 *      plain welcome (no whiff).
 *
 * "Open work" comes from the summary's `## Next Steps` section (preferred)
 * or the older `## Open Questions / TODO`. An empty / "none" section counts
 * as wrapped-clean.
 *
 * userVisibleOnly: the caller renders this in the user's terminal only,
 * never the model's additionalContext.
 *
 * Failure mode: any error (network/auth/missing table) returns null.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import { DeeplakeApi } from "../../deeplake-api.js";
import { loadConfig } from "../../config.js";
import { sqlStr, sqlIdent } from "../../utils/sql.js";
import { projectNameFromCwd } from "../../utils/project-name.js";
import { log as _log } from "../../utils/debug.js";

const log = (m: string) => _log("notifications-resume-brief", m);

/** Max length of the surfaced "next step" line — one terminal row. */
const MAX_LINE_CHARS = 120;

/** How many recent summaries to walk, newest-first, looking for the most
 *  recent session that left open work. A project untouched for a while
 *  resuming on an older-but-real TODO is fine. */
const LOOKBACK = 5;

/** Hard cap on the lookup. DeeplakeApi.query retries ~3.5s on an unreachable
 *  endpoint; the SessionStart hook budget is 5s and fetchOrgStats already
 *  spends up to 1.5s before us. Race it so a slow backend degrades to a
 *  plain welcome instead of stalling the hook. */
const QUERY_TIMEOUT_MS = 1_500;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

export interface ResumeBrief {
  brief: string;
}

/** Parse a wiki summary into a header→body map keyed by lowercased
 *  `## Header`. Body is everything up to the next `##` heading. */
function sections(summary: string): Map<string, string> {
  const map = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  for (const raw of summary.split(/\r?\n/)) {
    const h = raw.match(/^##\s+(.*?)\s*$/);
    if (h) {
      if (cur) map.set(cur.toLowerCase(), buf.join("\n").trim());
      cur = h[1]; buf = [];
    } else if (cur !== null) {
      buf.push(raw);
    }
  }
  if (cur) map.set(cur.toLowerCase(), buf.join("\n").trim());
  return map;
}

/** Treat these as "nothing left" even when the section is present. */
const EMPTY_SECTION = /^(none|n\/?a|n\.a\.|nothing|nothing pending|tbd|—|-)\.?$/i;

/**
 * The "what to resume" pointer for one summary, or "" when the session
 * wrapped clean. Prefers `## Next Steps`; falls back to the older
 * `## Open Questions / TODO`. Returns the first real line of that section
 * (bullet markers stripped), truncated to one row.
 */
export function extractNextSteps(summary: string): string {
  const s = sections(summary);
  const body = s.get("next steps") || s.get("open questions / todo") || s.get("open questions") || "";
  if (!body) return "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^[\s>]*[-*]?\s*/, "").replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim();
    if (!line) continue;
    if (EMPTY_SECTION.test(line)) return "";
    return truncate(line);
  }
  return "";
}

function truncate(s: string, max = MAX_LINE_CHARS): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice;
  return cut.trimEnd() + "…";
}

/** "3 days ago" / "yesterday" / "earlier today" from an ISO-ish timestamp,
 *  or "" when missing/unparseable so the caller can drop the clause. */
function relativeAge(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)} weeks ago`;
}

/**
 * Build the resume brief for a signed-in user, or null. Only called with
 * non-null creds — the gate lives in the caller (primary-banner), which
 * routes anonymous users to the signup brief instead.
 */
export async function pickResumeBrief(
  creds: Credentials | null | undefined,
): Promise<ResumeBrief | null> {
  if (!creds?.token || !creds.userName || !creds.orgId) return null;

  const project = projectNameFromCwd(process.cwd());
  if (!project) return null;

  try {
    const cfg = loadConfig();
    // sqlIdent throws on anything outside [A-Za-z_][A-Za-z0-9_]*. The table
    // name comes from HIVEMIND_TABLE — interpolated into FROM "${table}"
    // below, and sqlStr only escapes literals, not identifiers. Validate it;
    // on a bad value, bail to a plain welcome.
    let table: string;
    try {
      table = sqlIdent(cfg?.tableName ?? "memory");
    } catch (e: unknown) {
      log(`invalid table identifier "${cfg?.tableName}": ${(e as Error).message}`);
      return null;
    }
    const api = new DeeplakeApi(
      creds.token,
      creds.apiUrl ?? "https://api.deeplake.ai",
      creds.orgId,
      creds.workspaceId ?? "default",
      table,
    );

    // Last LOOKBACK summaries for THIS project by THIS user, newest first.
    const rows = await withTimeout(
      api.query(
        `SELECT summary, last_update_date FROM "${table}" ` +
          `WHERE project = '${sqlStr(project)}' AND author = '${sqlStr(creds.userName)}' ` +
          `AND summary <> '' ORDER BY last_update_date DESC LIMIT ${LOOKBACK}`,
      ),
      QUERY_TIMEOUT_MS,
      null,
    );
    if (!rows || rows.length === 0) {
      log(`silent (no prior summary for project=${project})`);
      return null; // outcome 3 — plain welcome
    }

    // Walk newest-first for the most recent session with real open work.
    for (const row of rows) {
      const summary = typeof row.summary === "string" ? row.summary : "";
      const next = extractNextSteps(summary);
      if (next.length >= 4) {
        const age = relativeAge(row.last_update_date as string | undefined);
        const when = age ? ` (${age})` : "";
        log(`fired (project=${project}, open work)`);
        return {
          brief:
            `Picking up on ${project}${when} — you left off here:\n` +
            `   📌 ${next}\n` +
            `   Ask me for the full thread whenever you're ready.`,
        }; // outcome 1 — with CTA
      }
    }

    // outcome 2 — summaries exist, but every recent session wrapped clean.
    const age = relativeAge(rows[0].last_update_date as string | undefined);
    const when = age ? ` ${age}` : "";
    log(`fired (project=${project}, no open work)`);
    return { brief: `Picking up on ${project} — last session${when} wrapped up clean, nothing pending.` };
  } catch (e: unknown) {
    log(`pickResumeBrief: ${(e as Error).message}`);
    return null;
  }
}
