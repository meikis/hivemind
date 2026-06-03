// Pull PostHog-related sessions from the org-wide Deeplake `sessions` table and
// reconstruct each into a condensed prompt/answer transcript (tool noise dropped).
import { dquery, SESSIONS_TABLE as T } from "./deeplake.ts";

export interface OrgCandidate { filename: string; hits: number }

export async function discoverOrgPosthogSessions(
  cap: number,
  excludeUuids: string[],
): Promise<OrgCandidate[]> {
  // Broad scan: high posthog-mention count anti-correlates with the narrow
  // "ship-and-verify-an-event" task (dashboards/analytics mention it constantly),
  // so order by recency, not hit count, and distill widely.
  const rows = await dquery(
    `SELECT filename, COUNT(*) AS hits, MAX(creation_date) AS last FROM "${T}" ` +
    `WHERE CAST(message AS TEXT) ILIKE '%posthog%' ` +
    `GROUP BY filename ORDER BY last DESC LIMIT ${cap * 2}`,
  );
  return rows
    .map((r) => ({ filename: String(r.filename), hits: Number(r.hits) }))
    .filter((c) => c.filename && !excludeUuids.some((u) => c.filename.includes(u)))
    .slice(0, cap);
}

// A stable id per org session: the uuid embedded in the filename, else the filename.
// Recent sessions across the org, any topic — for the satisfaction-judge probe
// (we want a diverse mix of good/bad outcomes, not a domain filter).
export async function discoverRecentSessions(cap: number): Promise<OrgCandidate[]> {
  const rows = await dquery(
    `SELECT filename, COUNT(*) AS hits, MAX(creation_date) AS last FROM "${T}" ` +
    `GROUP BY filename HAVING COUNT(*) >= 6 ORDER BY last DESC LIMIT ${cap}`,
  );
  return rows.map((r) => ({ filename: String(r.filename), hits: Number(r.hits) })).filter((c) => c.filename);
}

export function sessionId(filename: string): string {
  const m = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : filename.replace(/\.jsonl$/, "");
}

export async function reconstructCondense(filename: string, maxChars = 14_000): Promise<string> {
  const esc = filename.replace(/'/g, "''");
  const rows = await dquery(
    `SELECT message FROM "${T}" WHERE filename='${esc}' ORDER BY creation_date ASC`,
  );
  const parts: string[] = [];
  for (const r of rows) {
    let m: unknown = r.message;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch { continue; } }
    const j = m as { type?: string; content?: unknown };
    const text = typeof j?.content === "string" ? j.content.trim() : "";
    if (!text) continue;
    if (j.type === "user_message") parts.push(`USER: ${text}`);
    else if (j.type === "assistant_message") parts.push(`ASSISTANT: ${text}`);
  }
  let joined = parts.join("\n\n");
  if (joined.length > maxChars) {
    const head = joined.slice(0, Math.floor(maxChars * 0.55));
    const tail = joined.slice(joined.length - Math.floor(maxChars * 0.45));
    joined = `${head}\n\n...[middle elided]...\n\n${tail}`;
  }
  return joined;
}
