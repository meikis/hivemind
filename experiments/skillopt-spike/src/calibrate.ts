// Validate the judge BEFORE trusting any deltas: it must score a known-good
// answer high and an obviously-bad answer low. If it can't discriminate, the
// whole spike's reward signal is noise and the numbers mean nothing.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { llmJudgeScorer as scorer } from "./scorer.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";
import type { Task } from "./types.ts";

const BAD =
  "Honestly not sure. I'd just mock the PostHog client in a unit test and assume the event " +
  "fires correctly — no need to hit any real project or verify anything via the API.";

async function main() {
  const all: Task[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "tasks.json"), "utf8"));
  const sample = all.filter((t) => t.posthogRelevant).slice(0, 4);
  if (!sample.length) throw new Error("no relevant tasks; run dataprep first");

  const rows = await mapLimit(sample, 4, async (t) => {
    const good = await scorer.score(t, t.referenceOutcome); // known-good answer key
    const bad = await scorer.score(t, BAD); // anti-pattern (mock + no verify)
    return { id: t.id, good: good.soft, bad: bad.soft, ok: good.soft >= 0.6 && bad.soft <= 0.4 && good.soft > bad.soft };
  });

  console.log("judge calibration (good should be high, bad should be low):");
  for (const r of rows) {
    console.log(`  ${r.id}  good=${r.good.toFixed(2)}  bad=${r.bad.toFixed(2)}  ${r.ok ? "PASS" : "FAIL"}`);
  }
  const passed = rows.filter((r) => r.ok).length;
  console.log(`\n${passed}/${rows.length} discriminating | cost $${costSoFar().toFixed(2)}`);
  if (passed < Math.ceil(rows.length / 2)) {
    console.log("WARNING: judge is not reliably discriminating — treat spike deltas with suspicion.");
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
