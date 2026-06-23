#!/usr/bin/env node

/**
 * Proactive Recall — Claude Code UserPromptSubmit hook.
 *
 * On a *recall-worthy* prompt (cheap gate first — NOT every prompt), search the
 * team's summaries and, if the top hit clears a relevance bar, inject ONE
 * attributed snippet ("recalled from <teammate> · <date>") into the model
 * context. Every recall-worthy invocation is recorded to an always-on
 * `~/.deeplake/recall-events.jsonl` sink (independent of HIVEMIND_DEBUG) so
 * usage / hit-rate is directly measurable.
 *
 * Search mode: SEMANTIC (cosine) when embeddings are available, else falls back
 * to LEXICAL (ILIKE keyword overlap) — so recall works WITHOUT the embeddings
 * model installed. Each mode has its own precision gate.
 *
 * Design guarantees:
 *   - Precision-biased: skip aggressively; never inject below the bar.
 *   - Failure-isolated: any error → emit nothing, never block the prompt.
 *   - Latency-bounded: the whole search path is capped (withDeadline).
 *   - additionalContext on Claude Code is model-only (invisible to the user).
 *
 * Opt-out: this auto-search-and-inject is ENABLED BY DEFAULT. A user turns it
 * off (without affecting session capture or the agent's own reactive recall)
 * via HIVEMIND_PROACTIVE_RECALL_DISABLED=1 (or HIVEMIND_PROACTIVE_RECALL=0).
 * See proactiveRecallDisabled() in shared/recall-gate.ts.
 */

import { readStdin } from "../utils/stdin.js";
import { loadConfig } from "../config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { EmbedClient } from "../embeddings/client.js";
import { embeddingsDisabled } from "../embeddings/disable.js";
import { isHivemindPluginEnabled } from "../utils/plugin-state.js";
import { projectNameFromCwd } from "../utils/project-name.js";
import { log as _log } from "../utils/debug.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  shouldRecall,
  passesThreshold,
  extractKeywords,
  proactiveRecallDisabled,
  parsePositive,
  RECALL_THRESHOLD,
  MIN_LEXICAL_OVERLAP,
} from "./shared/recall-gate.js";
import { recallTopHit, recallTopHitLexical } from "./shared/recall-query.js";
import { formatRecallContext, type RecallHit } from "./shared/recall-format.js";
import { withDeadline } from "./shared/with-deadline.js";
import { recordRecallEvent } from "./shared/recall-events.js";

const log = (msg: string) => _log("recall", msg);

const SEMANTIC_ENABLED = process.env.HIVEMIND_SEMANTIC_SEARCH !== "false" && !embeddingsDisabled();
const EMBED_TIMEOUT_MS = parsePositive(process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS, 500);
// Hard ceiling on the recall critical path. recall runs SYNCHRONOUSLY on
// UserPromptSubmit — it blocks the turn — so we cap the worst case to a
// predictable budget and degrade to "skip" rather than stall on a slow backend.
const RECALL_BUDGET_MS = parsePositive(process.env.HIVEMIND_RECALL_TIMEOUT_MS, 1000);

type FindResult =
  | { kind: "hit"; hit: RecallHit }
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "timeout" };

const TIMED_OUT: FindResult = { kind: "timeout" };

function resolveDaemonPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "embeddings", "embed-daemon.js");
}

interface RecallInput {
  session_id?: string;
  prompt?: string;
  cwd?: string;
  hook_event_name?: string;
}

/** Emit the model-context injection (or nothing). Claude Code: model-only. */
function emit(additionalContext: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
  }));
}

/**
 * Find the top hit: semantic when embeddings yield a vector, else lexical.
 * Also falls back to lexical when semantic finds nothing (e.g. summaries not
 * embedded yet). Bounded by withDeadline in main.
 */
async function findHit(
  input: RecallInput,
  config: NonNullable<ReturnType<typeof loadConfig>>,
  signal: AbortSignal,
): Promise<FindResult> {
  const prompt = input.prompt ?? "";
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  // Pass the budget's abort signal so a timeout actually CANCELS the in-flight
  // query rather than leaving the socket/retry loop running.
  const q = (sql: string) => api.query(sql, signal) as Promise<Array<Record<string, unknown>>>;
  const opts = {
    // Scope to the CURRENT project: same-project summaries from any teammate
    // (the cross-teammate value) without injecting unrelated context from
    // other repos in the org. Org-wide only as a fallback when cwd is absent.
    // NOTE: `project` is the cwd basename — the SAME value capture tags rows
    // with — so this filter is exactly as precise as the stored data. Repos
    // that share a leaf directory name (…/foo/api and …/bar/api) collide; fully
    // disambiguating them needs a more-unique project key on summary rows (a
    // capture/schema change + migration), tracked separately. Basename scoping
    // is still strictly better than the org-wide search it replaced.
    project: input.cwd ? projectNameFromCwd(input.cwd) : undefined,
    excludePath: input.session_id ? `/summaries/${config.userName}/${input.session_id}.md` : undefined,
    limit: 3,
  };

  // Failure-isolated: catch our own I/O errors and report `error` so the caller
  // (and telemetry) never mislabels a backend failure as a deadline timeout.
  try {
    // Hybrid: prefer a semantic hit that clears the threshold; otherwise fall
    // through to lexical (exact keyword/identifier match), the same way the grep
    // path blends both. A below-threshold semantic hit must NOT suppress a good
    // lexical match (stack traces / exact error names).
    let semanticHit: RecallHit | null = null;
    if (SEMANTIC_ENABLED) {
      const vec = await new EmbedClient({ daemonEntry: resolveDaemonPath(), timeoutMs: EMBED_TIMEOUT_MS })
        .embed(prompt, "query");
      if (vec) {
        semanticHit = await recallTopHit(q, config.tableName, vec, opts);
        if (semanticHit && passesThreshold(semanticHit.score)) return { kind: "hit", hit: semanticHit };
      }
    }

    const keywords = extractKeywords(prompt);
    if (keywords.length >= 2) {
      const lex = await recallTopHitLexical(q, config.tableName, keywords, opts);
      if (lex && lex.score >= MIN_LEXICAL_OVERLAP) return { kind: "hit", hit: lex };
    }

    // Nothing cleared a bar. Surface the below-threshold semantic hit (so
    // telemetry records 'below') if we had one; otherwise nothing matched.
    return semanticHit ? { kind: "hit", hit: semanticHit } : { kind: "none" };
  } catch (e) {
    // Includes the AbortError when the budget cancels us mid-flight; the
    // wrapper has already settled to TIMED_OUT in that case, so this result is
    // ignored. A genuine fast failure is reported as `error`.
    log(`search error: ${(e as Error)?.message ?? e}`);
    return { kind: "error" };
  }
}

/** Mode-aware relevance gate: cosine threshold for semantic, overlap for lexical. */
function hitPasses(hit: RecallHit): boolean {
  return hit.mode === "semantic"
    ? passesThreshold(hit.score)
    : hit.score >= MIN_LEXICAL_OVERLAP;
}

async function main(): Promise<void> {
  if (proactiveRecallDisabled()) return; // on by default; opt out: HIVEMIND_PROACTIVE_RECALL_DISABLED=1
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  if (!isHivemindPluginEnabled()) return;

  const input = await readStdin<RecallInput>();

  // Layer 0/1 gate — the whole point: don't search on every prompt.
  const { recall, reason } = shouldRecall(input.prompt);
  if (!recall) { log(`skip gate=${reason}`); return; }

  const session = input.session_id;
  const config = loadConfig();
  if (!config?.token) {
    log("skip no-config");
    recordRecallEvent({ event: "no-config", gate: reason, session });
    return;
  }

  // Bound the whole search path so the turn never stalls beyond the budget.
  // On timeout we ABORT the controller so the in-flight query is cancelled
  // (not just abandoned) and the hook process can exit promptly.
  const controller = new AbortController();
  const res = await withDeadline(findHit(input, config, controller.signal), RECALL_BUDGET_MS, TIMED_OUT);
  if (res.kind === "timeout") {
    controller.abort();
    log(`skip timeout budget=${RECALL_BUDGET_MS}ms`);
    recordRecallEvent({ event: "timeout", gate: reason, session });
    return;
  }
  if (res.kind === "error") {
    log(`skip search-error gate=${reason}`);
    recordRecallEvent({ event: "error", gate: reason, session });
    return;
  }
  if (res.kind === "none") {
    log(`searched gate=${reason} hit=none`);
    recordRecallEvent({ event: "none", gate: reason, session });
    return;
  }

  const hit = res.hit;
  const teammate = hit.author !== config.userName;
  const bar = hit.mode === "semantic" ? `thr=${RECALL_THRESHOLD}` : `min=${MIN_LEXICAL_OVERLAP}`;
  if (!hitPasses(hit)) {
    log(`searched mode=${hit.mode} hit=below score=${hit.score} ${bar} author=${hit.author}`);
    recordRecallEvent({ event: "below", gate: reason, mode: hit.mode, score: hit.score, author: hit.author, teammate, project: hit.project, session });
    return;
  }

  const additionalContext = formatRecallContext({ hit, currentUser: config.userName, now: Date.now() });
  if (!additionalContext) {
    log(`searched mode=${hit.mode} hit=unattributable score=${hit.score}`);
    recordRecallEvent({ event: "unattributable", mode: hit.mode, score: hit.score, session });
    return;
  }

  // Structured recall event — debug log (opt-in) + always-on JSONL sink.
  log(`injected mode=${hit.mode} score=${hit.score} author=${hit.author} teammate=${teammate} project=${hit.project}`);
  recordRecallEvent({ event: "injected", gate: reason, mode: hit.mode, score: hit.score, author: hit.author, teammate, project: hit.project, session });
  emit(additionalContext);
}

main().catch((e) => { log(`fatal: ${e?.message ?? e}`); process.exit(0); });
