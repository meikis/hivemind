// The spike: measure a real skill with/without SkillOpt-style optimization.
//   baseline(no-skill) -> original-skill -> [reflect->edit->gate loop] -> optimized-skill
// Headline = optimized vs original delta on a held-out TEST split.
import fs from "node:fs";
import path from "node:path";
import {
  SKILL_PATH, DATA_DIR, OUT_DIR, SPLIT, EDIT_BUDGET, MAX_STEPS, MINIBATCH,
} from "./config.ts";
import { readSkillBody } from "./skillfile.ts";
import { rollout } from "./rollout.ts";
import { llmJudgeScorer as scorer, mean } from "./scorer.ts";
import { reflect, type ScoredRollout } from "./reflect.ts";
import { applyEdits } from "./edit.ts";
import { evaluateGate } from "./gate.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";
import type { Task, Edit } from "./types.ts";

interface Measured {
  soft: number;
  hard: number;
  details: { taskId: string; soft: number; hard: number; rationale: string }[];
}

async function measure(tasks: Task[], skillBody: string | null): Promise<Measured> {
  const raw = await mapLimit(tasks, 3, async (t) => {
    try {
      const { output } = await rollout(t, skillBody);
      const s = await scorer.score(t, output);
      return { taskId: t.id, soft: s.soft, hard: s.hard, rationale: s.rationale };
    } catch (e) {
      console.log(`  ! skipped task ${t.id}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  const details = raw.filter((d): d is NonNullable<typeof d> => d !== null);
  return { soft: mean(details.map((d) => d.soft)), hard: mean(details.map((d) => d.hard)), details };
}

// Roll out + score a minibatch under the current skill (used by reflect).
async function scoreBatch(tasks: Task[], skillBody: string): Promise<ScoredRollout[]> {
  const raw = await mapLimit(tasks, 3, async (t) => {
    try {
      const { output } = await rollout(t, skillBody);
      const s = await scorer.score(t, output);
      return { task: t, output, score: { hard: s.hard, soft: s.soft, rationale: s.rationale } };
    } catch (e) {
      console.log(`  ! skipped task ${t.id}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  return raw.filter((r): r is ScoredRollout => r !== null);
}

function splitTasks(relevant: Task[]) {
  const n = relevant.length;
  // Adaptive: never starve train. Shrink test/val when data is scarce.
  const nTest = n >= 8 ? SPLIT.test : n >= 6 ? 2 : 1;
  const nVal = n >= 8 ? SPLIT.val : n >= 5 ? 1 : 1;
  const mined = relevant.filter((t) => t.provenance === "mined");
  const source = relevant.filter((t) => t.provenance === "source");
  // Prefer leakage-free (mined) tasks for TEST.
  const test = [...mined].slice(0, nTest);
  while (test.length < nTest && source.length) test.push(source.shift()!);
  const testIds = new Set(test.map((t) => t.id));
  const rest = relevant.filter((t) => !testIds.has(t.id));
  const val = rest.slice(0, nVal);
  const train = rest.slice(nVal);
  return { train, val, test };
}

function loadTasks(): Task[] {
  const byId = new Map<string, Task>();
  for (const file of ["tasks.json", "tasks-org.json"]) {
    try {
      const arr: Task[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));
      for (const t of arr) if (!byId.has(t.id)) byId.set(t.id, t);
    } catch { /* file may not exist */ }
  }
  return [...byId.values()];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const all = loadTasks();
  const relevant = all.filter((t) => t.posthogRelevant);
  const { train, val, test } = splitTasks(relevant);
  console.log(`tasks: ${relevant.length} relevant -> train=${train.length} val=${val.length} test=${test.length}`);
  if (train.length < 2 || val.length < 1 || test.length < 1) {
    throw new Error("not enough relevant tasks to split; run dataprep with a higher target");
  }

  const originalSkill = readSkillBody(SKILL_PATH);

  // --- baselines on TEST ---
  console.log("\n== TEST baseline: no skill ==");
  const noSkill = await measure(test, null);
  console.log(`  soft=${noSkill.soft.toFixed(3)} hard=${noSkill.hard.toFixed(3)}`);
  console.log("== TEST: original skill ==");
  const origTest = await measure(test, originalSkill);
  console.log(`  soft=${origTest.soft.toFixed(3)} hard=${origTest.hard.toFixed(3)}`);

  // --- optimization loop ---
  let current = originalSkill;
  let curValScore: number | null = null;
  const stepLog: unknown[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const start = (step * MINIBATCH) % train.length;
    const batch = train.slice(start, start + MINIBATCH);
    const mb = batch.length ? batch : train.slice(0, MINIBATCH);
    console.log(`\n== step ${step + 1}/${MAX_STEPS} (minibatch ${mb.length}) ==`);

    const scored = await scoreBatch(mb, current);
    const failures = scored.filter((r) => r.score.hard === 0 || r.score.soft < 0.6);
    const successes = scored.filter((r) => r.score.hard === 1 && r.score.soft >= 0.6);
    console.log(`  batch: ${failures.length} fail / ${successes.length} ok (mean soft ${mean(scored.map((s) => s.score.soft)).toFixed(2)})`);

    let edits: Edit[] = [];
    let reasoning = "";
    if (failures.length) {
      const r = await reflect("failure", current, failures, EDIT_BUDGET);
      edits = r.edits; reasoning = r.reasoning;
    } else if (successes.length) {
      const r = await reflect("success", current, successes, EDIT_BUDGET);
      edits = r.edits; reasoning = r.reasoning;
    }
    if (!edits.length) { console.log("  no edits proposed; skipping"); stepLog.push({ step, action: "no_edits" }); continue; }

    const { skill: candidate, report } = applyEdits(current, edits);
    console.log(`  proposed ${edits.length} edits:`, report.join(" | "));
    if (candidate === current) { console.log("  edits were no-ops; reject"); stepLog.push({ step, action: "noop_edits", report }); continue; }

    if (curValScore === null) curValScore = (await measure(val, current)).soft;
    const candVal = (await measure(val, candidate)).soft;
    const gate = evaluateGate(candVal, curValScore);
    console.log(`  gate: cand val ${candVal.toFixed(3)} vs cur ${curValScore.toFixed(3)} -> ${gate.accept ? "ACCEPT" : "reject"}`);

    stepLog.push({ step, reasoning, edits, report, candVal, curVal: curValScore, accepted: gate.accept });
    if (gate.accept) { current = candidate; curValScore = candVal; }
  }

  // --- optimized on TEST ---
  console.log("\n== TEST: optimized skill ==");
  const optTest = await measure(test, current);
  console.log(`  soft=${optTest.soft.toFixed(3)} hard=${optTest.hard.toFixed(3)}`);

  // Apples-to-apples: only compare on test tasks that were successfully scored
  // in ALL THREE conditions (timeouts/skips can drop a task from one condition).
  const idsIn = (m: Measured) => new Set(m.details.map((x) => x.taskId));
  const a = idsIn(noSkill), b = idsIn(origTest), c = idsIn(optTest);
  const common = test.map((t) => t.id).filter((id) => a.has(id) && b.has(id) && c.has(id));
  const commonSet = new Set(common);
  const overCommon = (m: Measured) => {
    const f = m.details.filter((x) => commonSet.has(x.taskId));
    return { soft: mean(f.map((x) => x.soft)), hard: mean(f.map((x) => x.hard)) };
  };
  const cNo = overCommon(noSkill), cOrig = overCommon(origTest), cOpt = overCommon(optTest);

  const results = {
    skillPath: SKILL_PATH,
    split: { train: train.map((t) => t.id), val: val.map((t) => t.id), test: test.map((t) => t.id) },
    hyper: { EDIT_BUDGET, MAX_STEPS, MINIBATCH },
    testRaw: { noSkill, original: origTest, optimized: optTest },
    commonTaskIds: common,
    testCommon: { noSkill: cNo, original: cOrig, optimized: cOpt },
    stepLog,
    cost: { usd: costSoFar(), calls: callsSoFar() },
  };
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "optimized_skill.md"), current);

  const d = (x: number, y: number) => (y - x >= 0 ? "+" : "") + (y - x).toFixed(3);
  console.log(`\n========= SPIKE RESULT (${common.length}/${test.length} test tasks scored in all 3 conditions) =========`);
  console.log(`                       soft     hard`);
  console.log(`  no-skill           ${cNo.soft.toFixed(3)}    ${cNo.hard.toFixed(3)}`);
  console.log(`  original skill     ${cOrig.soft.toFixed(3)}    ${cOrig.hard.toFixed(3)}`);
  console.log(`  optimized skill    ${cOpt.soft.toFixed(3)}    ${cOpt.hard.toFixed(3)}`);
  console.log(`  ---`);
  console.log(`  HEADLINE  optimized vs original: soft ${d(cOrig.soft, cOpt.soft)}  hard ${d(cOrig.hard, cOpt.hard)}`);
  console.log(`  context   skill vs no-skill:    soft ${d(cNo.soft, cOrig.soft)}  hard ${d(cNo.hard, cOrig.hard)}`);
  console.log(`  cost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls`);
  console.log("===========================================================");
}

main().catch((e) => { console.error(e); process.exit(1); });
