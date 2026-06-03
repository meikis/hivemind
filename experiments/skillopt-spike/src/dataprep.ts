// Step 1: build a replayable eval set of {task, referenceOutcome} from real sessions.
//   - "source" tasks: from the skill's own source_sessions (potential leakage)
//   - "mined" tasks: PostHog sessions discovered elsewhere in the local corpus (leakage-free)
import fs from "node:fs";
import path from "node:path";
import {
  SOURCE_SESSION_UUIDS, TRANSCRIPT_ROOT, DATA_DIR, CURRENT_SESSION_ID,
  RELEVANT_TARGET, MINE_DISTILL_CAP, MINE_CONCURRENCY, MINE_MIN_HITS,
} from "./config.ts";
import { findTranscript, condenseTranscript, discoverPosthogCandidates } from "./transcript.ts";
import { callLLM, extractJson, costSoFar } from "./llm.ts";
import { DATAPREP_SYS, dataprepUser } from "./prompts.ts";
import { mapLimit } from "./util.ts";
import type { Task } from "./types.ts";

async function distill(file: string, uuid: string, provenance: "source" | "mined"): Promise<Task | null> {
  const condensed = condenseTranscript(file);
  if (condensed.length < 200) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const suffix = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose, no markdown, no headings.";
      const { text } = await callLLM("dataprep", DATAPREP_SYS, dataprepUser(condensed) + suffix);
      const p = extractJson<{ posthog_relevant: boolean; task_prompt: string; reference_outcome: string }>(text);
      return {
        id: uuid,
        taskPrompt: p.task_prompt,
        referenceOutcome: p.reference_outcome,
        posthogRelevant: !!p.posthog_relevant,
        provenance,
      };
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, "tasks.json");

  // Incremental: keep what we already distilled, only add new sessions.
  const tasks: Task[] = [];
  try {
    tasks.push(...(JSON.parse(fs.readFileSync(outPath, "utf8")) as Task[]));
    console.log(`loaded ${tasks.length} existing tasks`);
  } catch { /* fresh */ }
  const seen = new Set(tasks.map((t) => t.id));

  // --- source sessions ---
  console.log("== distilling source sessions ==");
  for (const uuid of SOURCE_SESSION_UUIDS) {
    if (seen.has(uuid)) continue;
    const file = findTranscript(TRANSCRIPT_ROOT, uuid);
    if (!file) { console.log(`MISS ${uuid}`); continue; }
    const t = await distill(file, uuid, "source");
    if (t) { tasks.push(t); seen.add(uuid); console.log(`  ${uuid} posthog=${t.posthogRelevant}`); }
    else console.log(`  ${uuid} FAIL/empty`);
  }

  // --- mine more posthog sessions until we hit the relevant target ---
  const relevantSoFar = () => tasks.filter((t) => t.posthogRelevant).length;
  if (relevantSoFar() < RELEVANT_TARGET) {
    const exclude = new Set<string>([...seen, ...SOURCE_SESSION_UUIDS, CURRENT_SESSION_ID]);
    const candidates = discoverPosthogCandidates(TRANSCRIPT_ROOT, exclude, MINE_MIN_HITS).slice(0, MINE_DISTILL_CAP);
    console.log(`\n== mining ${candidates.length} candidate posthog sessions (concurrency ${MINE_CONCURRENCY}) ==`);
    const mined = await mapLimit(candidates, MINE_CONCURRENCY, async (c) => {
      const t = await distill(c.file, c.uuid, "mined");
      console.log(`  ${c.uuid} (${c.hits} hits) -> ${t ? `posthog=${t.posthogRelevant}` : "FAIL"}`);
      return t;
    });
    for (const t of mined) if (t) tasks.push(t);
  }

  fs.writeFileSync(outPath, JSON.stringify(tasks, null, 2));
  const rel = tasks.filter((t) => t.posthogRelevant);
  console.log(
    `\nWrote ${tasks.length} tasks (${rel.length} posthog-relevant: ` +
    `${rel.filter((t) => t.provenance === "source").length} source / ${rel.filter((t) => t.provenance === "mined").length} mined) ` +
    `-> ${outPath}  | cost so far $${costSoFar().toFixed(2)}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
