#!/usr/bin/env node

/**
 * Proactive Recall — Claude Code UserPromptSubmit hook.
 *
 * On a *recall-worthy* prompt (cheap gate first — NOT every prompt), semantic-
 * search the team's summaries and, if the top hit clears a relevance
 * threshold, inject ONE attributed snippet ("recalled from <teammate> ·
 * <date>") into the model context. Logs a structured `recall` event so value
 * is measurable (searched / hit / injected / score).
 *
 * Design guarantees:
 *   - Precision-biased: skip aggressively; never inject below threshold.
 *   - Failure-isolated: any error → emit nothing, never block the prompt.
 *   - additionalContext on Claude Code is model-only (invisible to the user).
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
import { shouldRecall, passesThreshold, RECALL_THRESHOLD } from "./shared/recall-gate.js";
import { recallTopHit } from "./shared/recall-query.js";
import { formatRecallContext } from "./shared/recall-format.js";

const log = (msg: string) => _log("recall", msg);

const SEMANTIC_ENABLED = process.env.HIVEMIND_SEMANTIC_SEARCH !== "false" && !embeddingsDisabled();
const EMBED_TIMEOUT_MS = Number(process.env.HIVEMIND_SEMANTIC_EMBED_TIMEOUT_MS ?? "500");

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

async function main(): Promise<void> {
  if (process.env.HIVEMIND_RECALL === "false") return;
  if (process.env.HIVEMIND_WIKI_WORKER === "1") return;
  if (!isHivemindPluginEnabled()) return;

  const input = await readStdin<RecallInput>();

  // Layer 0/1 gate — the whole point: don't search on every prompt.
  const { recall, reason } = shouldRecall(input.prompt);
  if (!recall) { log(`skip gate=${reason}`); return; }
  if (!SEMANTIC_ENABLED) { log("skip embeddings-disabled"); return; }

  const config = loadConfig();
  if (!config?.token) { log("skip no-config"); return; }

  const vec = await new EmbedClient({ daemonEntry: resolveDaemonPath(), timeoutMs: EMBED_TIMEOUT_MS })
    .embed(input.prompt ?? "", "query");
  if (!vec) { log("skip embed-unavailable"); return; }

  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  const ownSummary = input.session_id
    ? `/summaries/${config.userName}/${input.session_id}.md`
    : undefined;

  const hit = await recallTopHit(
    (sql) => api.query(sql) as Promise<Array<Record<string, unknown>>>,
    config.tableName,
    vec,
    { excludePath: ownSummary, limit: 3 },
  );

  if (!hit) { log(`searched gate=${reason} hit=none`); return; }

  const teammate = hit.author !== config.userName;
  const top = hit.score.toFixed(3);
  if (!passesThreshold(hit.score)) {
    log(`searched gate=${reason} hit=below score=${top} thr=${RECALL_THRESHOLD} author=${hit.author}`);
    return;
  }

  const additionalContext = formatRecallContext({ hit, currentUser: config.userName, now: Date.now() });
  if (!additionalContext) { log(`searched gate=${reason} hit=unattributable score=${top}`); return; }

  // Structured, greppable recall event (the measurable value signal).
  log(`injected gate=${reason} score=${top} author=${hit.author} teammate=${teammate} project=${hit.project}`);
  emit(additionalContext);
}

main().catch((e) => { log(`fatal: ${e?.message ?? e}`); process.exit(0); });
