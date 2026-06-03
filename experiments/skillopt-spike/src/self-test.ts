// SELF-REFERENTIAL test: the best real test case is THIS session's own recurring failure.
// In this session the agent repeatedly defaulted to "skill-vs-no-skill" when asked to evaluate a
// skill EDIT, instead of "v1-vs-v2", despite corrections. A skill mined from that failure should
// prevent recurrence. We test it as v1-vs-v2 (fitting the lesson): a WEAK version of the skill vs
// the SHARP version — does the sharp edit make a fresh agent pick the right comparison?
import { callLLM, extractJson } from "./llm.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";

// v1 = vague "before the edit". v2 = the sharp lesson mined from this session's real failure.
const SKILL_V1 = `## Evaluating skills
Think about how to tell whether a skill is good. Compare outcomes in some reasonable way.`;

const SKILL_V2 = `## Evaluating a skill optimization: compare VERSIONS, not presence
When checking whether an EDIT to a skill improved it, compare the NEW version against the PREVIOUS
version (v1 vs v2) on the same tasks. That is the only comparison that answers "did this edit help?".
Do NOT default to comparing skill-vs-no-skill (with/without) — that answers a DIFFERENT question
("is this skill worth having at all?"), not "did our edit improve it." Using skill-vs-no-skill to
judge an optimization silently measures the wrong thing.
- "did the edit help?" / optimization gate  -> vN vs vN+1 (version vs version), same tasks, keep if better.
- "is the skill worth keeping at all?" / brand-new skill -> with-skill vs without.
If you catch yourself setting up with/without to judge an edit, stop — that's the wrong axis.`;

const TASKS = [
  "We have a shared skill and just made an edit to improve it. How should we test whether the edit actually made the skill better? Describe the exact comparison.",
  "Design the evaluation step for a skill-optimization loop: after the optimizer edits a skill, how do we decide whether to keep the edit?",
  "We refined a team skill (added a rule). What comparison confirms the refinement helped?",
  "Our pipeline proposes edits to skills. What's the right way to validate that a given edit is an improvement?",
  "A skill went from version 3 to version 4 after an automated edit. How do we measure if v4 is actually better?",
];

const SYS = "You are an engineer designing how to evaluate AI 'skills'. Answer concisely with the concrete comparison you would run.";

async function classify(answer: string): Promise<"version" | "presence" | "other"> {
  const { text } = await callLLM("judge", "You classify an evaluation approach. JSON only.",
    `Below is a proposed way to evaluate whether a skill EDIT improved a skill.
Classify the PRIMARY comparison it proposes:
- "version"  = compares the new skill version vs the previous version (v1 vs v2 / vN vs vN+1).
- "presence" = compares having the skill vs not having it (with-skill vs without / skill vs no-skill).
- "other"    = neither clearly.
Return JSON: {"primary":"version"|"presence"|"other"}

ANSWER:
${answer}`);
  return extractJson<{ primary: "version" | "presence" | "other" }>(text).primary;
}

async function runArm(label: string, skillBody: string) {
  const cls = await mapLimit(TASKS, 4, async (task) => {
    const { text } = await callLLM("target", `${SYS}\n\nApply this SKILL:\n<skill>\n${skillBody}\n</skill>`, task);
    return classify(text);
  });
  const version = cls.filter((c) => c === "version").length;
  const presence = cls.filter((c) => c === "presence").length;
  console.log(`  ${label}: chose version-vs-version ${version}/${TASKS.length} | skill-vs-no-skill(the mistake) ${presence}/${TASKS.length} | other ${TASKS.length - version - presence}`);
  return version / TASKS.length;
}

async function main() {
  console.log(`SELF-REFERENTIAL v1-vs-v2 test: does the skill mined from THIS session's failure stop the agent\nfrom repeating it (defaulting to skill-vs-no-skill when it should do v1-vs-v2)?\n`);
  const v1 = await runArm("v1 (vague)  ", SKILL_V1);
  const v2 = await runArm("v2 (sharp)  ", SKILL_V2);
  console.log(`\nshare doing the CORRECT v1-vs-v2 framing:  v2 ${(v2 * 100).toFixed(0)}%  vs  v1 ${(v1 * 100).toFixed(0)}%  =>  edit effect ${v2 - v1 >= 0 ? "+" : ""}${((v2 - v1) * 100).toFixed(0)}pp`);
  console.log(`${v2 > v1 ? "PASS" : "CHECK"}: ${v2 > v1 ? "the v1->v2 edit measurably makes the agent avoid the exact mistake from this session." : "no improvement — inspect."}`);
  console.log(`\ncost $${costSoFar().toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
