// E2E capstone: does the SkillOpt loop measurably improve a REAL org skill, validated
// on REAL held-out tasks, with noise killed (pairwise) and redundancy killed (proprietary skill)?
//
// Two experiments on a proprietary org skill (default pg-deeplake-test-crash-debugging):
//   (1) SKILL-MATTERS: pairwise(original skill vs no-skill) on held-out tasks.
//   (2) ABLATION-RECOVERY: ablate the skill -> run reflect->edit loop on train tasks ->
//       pairwise(recovered vs ablated) on held-out tasks. Controlled proof the loop improves it.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, OUT_DIR, MODELS } from "./config.ts";
import { dquery } from "./deeplake.ts";
import { discoverByKeyword, reconstructCondense, sessionId } from "./orgsource.ts";
import { distillText } from "./distill.ts";
import { rollout } from "./rollout.ts";
import { llmJudgeScorer as scorer } from "./scorer.ts";
import { reflect } from "./reflect.ts";
import { applyEdits } from "./edit.ts";
import { pairwise } from "./pairwise.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";
import type { Task } from "./types.ts";

const TARGET_SKILL = process.env.SPIKE_E2E_SKILL || "pg-deeplake-test-crash-debugging";
const KW = process.env.SPIKE_E2E_KW || "pg_deeplake";
const N_SESS = Number(process.env.SPIKE_E2E_SESS || 44);
const N_TEST = Number(process.env.SPIKE_E2E_TEST || 14);
const N_TRAIN = Number(process.env.SPIKE_E2E_TRAIN || 14);
const EDIT_BUDGET = Number(process.env.SPIKE_E2E_BUDGET || 6);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Ablate ~half the skill's "## " sections to simulate a deficient skill with a real gap.
function ablate(body: string): string {
  const parts = body.split(/(?=^## )/m);
  if (parts.length < 3) return body.slice(0, Math.floor(body.length / 2));
  const keep = Math.ceil(parts.length / 2);
  return parts.slice(0, keep).join("").trim();
}

// pairwise win of `optSkill` over `origSkill` across held-out tasks (both null = no-skill).
async function validate(tasks: Task[], origSkill: string | null, optSkill: string | null, label: string) {
  const scores = (await mapLimit(tasks, 4, async (t) => {
    try {
      const [so, sp] = await Promise.all([rollout(t, origSkill), rollout(t, optSkill)]);
      return await pairwise(t.taskPrompt, t.referenceOutcome, so.output, sp.output);
    } catch { return null; }
  })).filter((x): x is number => x !== null);
  const m = mean(scores);
  const wins = scores.filter((s) => s > 0).length, losses = scores.filter((s) => s < 0).length;
  console.log(`  [${label}] n=${scores.length}  mean optScore ${m >= 0 ? "+" : ""}${m.toFixed(3)}  (wins ${wins} / losses ${losses} / ties ${scores.length - wins - losses})`);
  return { label, n: scores.length, mean: m, wins, losses };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`E2E target skill: ${TARGET_SKILL} (kw '${KW}'), target model ${MODELS.target}`);

  const rows = await dquery(`SELECT body FROM "skills" WHERE name = '${TARGET_SKILL.replace(/'/g, "''")}' ORDER BY version DESC LIMIT 1`);
  if (!rows.length) throw new Error(`skill ${TARGET_SKILL} not found in org table`);
  const S = String(rows[0].body);
  console.log(`loaded skill (${S.length} chars)`);

  // in-domain sessions -> tasks
  const cands = await discoverByKeyword(KW, N_SESS);
  console.log(`distilling ${cands.length} in-domain sessions into tasks...`);
  const tasks = (await mapLimit(cands, 6, async (c) => {
    try {
      const text = await reconstructCondense(c.filename);
      return await distillText(text, sessionId(c.filename), "mined");
    } catch { return null; }
  })).filter((t): t is Task => !!t && t.taskPrompt.length > 120 && t.referenceOutcome.length > 120);
  console.log(`got ${tasks.length} usable tasks`);
  const testTasks = tasks.slice(0, N_TEST);
  const trainTasks = tasks.slice(N_TEST, N_TEST + N_TRAIN);
  if (testTasks.length < 6 || trainTasks.length < 4) throw new Error("not enough tasks");

  // ---- reflect->edit loop on the ABLATED skill, using train tasks ----
  const Sablated = ablate(S);
  console.log(`\nablated skill: ${S.length} -> ${Sablated.length} chars; running reflect loop on ${trainTasks.length} train tasks...`);
  let Srec = Sablated;
  for (let step = 0; step < 2; step++) {
    const scored = await mapLimit(trainTasks, 4, async (t) => {
      try { const r = await rollout(t, Srec); const s = await scorer.score(t, r.output); return { task: t, output: r.output, score: { hard: s.hard, soft: s.soft, rationale: s.rationale } }; }
      catch { return null; }
    });
    const fails = scored.filter((x): x is NonNullable<typeof x> => !!x).filter((x) => x.score.soft < 0.7);
    if (!fails.length) { console.log(`  step ${step}: no failures to learn from`); break; }
    const r = await reflect("failure", Srec, fails, EDIT_BUDGET);
    const { skill: cand, report } = applyEdits(Srec, r.edits);
    console.log(`  step ${step}: ${fails.length} fails -> ${r.edits.length} edits (${report.filter((x) => x.startsWith("OK")).length} applied)`);
    if (cand !== Srec) Srec = cand;
  }
  console.log(`recovered skill: ${Srec.length} chars`);

  // ---- VALIDATE (pairwise, held-out) ----
  console.log(`\nVALIDATION (pairwise on ${testTasks.length} held-out tasks, target ${MODELS.target}):`);
  const r1 = await validate(testTasks, null, S, "skill-matters: original vs no-skill");
  const r2 = await validate(testTasks, Sablated, Srec, "loop-works: recovered vs ablated");
  const r3 = await validate(testTasks, S, Srec, "sanity: recovered vs FULL original (should be ~tie/neg)");

  fs.writeFileSync(path.join(OUT_DIR, "e2e-results.json"), JSON.stringify({ skill: TARGET_SKILL, target: MODELS.target, sizes: { test: testTasks.length, train: trainTasks.length }, results: [r1, r2, r3] }, null, 2));
  console.log(`\ncost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls | wrote out/e2e-results.json`);
  console.log("INTERPRET: r1 mean >> 0 => proprietary skill matters. r2 mean > 0 => the loop measurably recovers/improves a deficient real skill. r3 ~<=0 => loop didn't surpass the human-written full skill (honest ceiling).");
}

main().catch((e) => { console.error(e); process.exit(1); });
