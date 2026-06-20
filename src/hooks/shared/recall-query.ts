/**
 * Proactive-recall query — a focused semantic search over the summaries
 * (`memory`) table that returns ONE scored, attributed hit.
 *
 * Distinct from grep-core's searchDeeplakeTables (which returns grep-shaped
 * {path,content} with no score): recall needs the cosine score to threshold
 * on relevance and the author/date/project to attribute the hit. Mirrors the
 * proven cosine pattern: `(summary_embedding <#> vec) AS score ORDER BY score
 * DESC`, where `<#>` is normalized similarity (0..1, higher = closer).
 */

import { serializeFloat4Array } from "../../shell/grep-core.js";
import { sqlStr } from "../../utils/sql.js";
import type { RecallHit } from "./recall-format.js";

export interface RecallQueryOptions {
  /** Restrict to this project when set (most relevant); omit for org-wide. */
  project?: string;
  /** Exclude this exact summary path (e.g. the current session's own row). */
  excludePath?: string;
  /** Top-K rows to fetch before taking the best. */
  limit?: number;
}

type QueryFn = (sql: string) => Promise<Array<Record<string, unknown>>>;

/**
 * Return the single best-scoring summary for `queryEmbedding`, or null when
 * the table has no embedded rows / the query yields nothing. The caller
 * applies the relevance threshold (passesThreshold) — this returns the raw
 * top hit so telemetry can record near-misses.
 */
export async function recallTopHit(
  query: QueryFn,
  memoryTable: string,
  queryEmbedding: number[],
  opts: RecallQueryOptions = {},
): Promise<RecallHit | null> {
  const vecLit = serializeFloat4Array(queryEmbedding);
  if (vecLit === "NULL") return null;

  const filters = [`ARRAY_LENGTH(summary_embedding, 1) > 0`];
  if (opts.project) filters.push(`project = '${sqlStr(opts.project)}'`);
  if (opts.excludePath) filters.push(`path <> '${sqlStr(opts.excludePath)}'`);

  const sql =
    `SELECT path, author, project, description, last_update_date, ` +
    `(summary_embedding <#> ${vecLit}) AS score ` +
    `FROM "${memoryTable}" WHERE ${filters.join(" AND ")} ` +
    `ORDER BY score DESC LIMIT ${Math.max(1, opts.limit ?? 3)}`;

  const rows = await query(sql);
  if (!rows.length) return null;
  const r = rows[0];
  const score = Number(r["score"]);
  return {
    path: String(r["path"] ?? ""),
    author: String(r["author"] ?? ""),
    project: String(r["project"] ?? ""),
    description: String(r["description"] ?? ""),
    lastUpdate: String(r["last_update_date"] ?? ""),
    score: Number.isFinite(score) ? score : 0,
  };
}
