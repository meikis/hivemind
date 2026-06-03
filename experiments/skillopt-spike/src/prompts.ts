// Prompt templates. Kept as plain strings here for the spike; these are the
// pieces that port into hivemind's mining loop (B) if the spike succeeds.

// ---- Data prep: distill a real session into a replayable task + reference outcome ----
export const DATAPREP_SYS =
  "You convert a real engineering session transcript into a single replayable evaluation task. " +
  "You output strict JSON only.";

export function dataprepUser(condensed: string): string {
  return `Below is a condensed transcript of a real coding session (user prompts + assistant text, tool noise removed).

Extract ONE self-contained task that an engineer was actually trying to accomplish in this session, focused on the PostHog-analytics-event work if present.

Return strict JSON (no fences):
{
  "posthog_relevant": <true|false>,        // is this session genuinely about shipping/verifying a PostHog event end-to-end?
  "task_prompt": "<the SITUATION and GOAL only, with the SOLUTION stripped out — what an engineer is asked to do, phrased so it can be attempted fresh. Include concrete specifics (event name, properties, funnel) but NOT the steps taken>",
  "reference_outcome": "<concise description of what ACTUALLY worked in this session: the concrete approach/code/commands/verification that achieved the goal. This is the known-good answer key>"
}

If the session is not really about PostHog event work, set posthog_relevant=false and still fill task_prompt/reference_outcome with the best available task.

CONDENSED TRANSCRIPT:
${condensed}`;
}

// ---- Target rollout system prompts ----
export const TARGET_SYS_BASE =
  "You are an experienced engineer working in the deeplake-api (Go) / hivemind codebase. " +
  "Given a task, produce your concrete solution as text: the approach, the key code, the exact " +
  "commands you would run, and how you would verify it worked. You cannot run tools — write the " +
  "solution as your answer. Be focused: show the load-bearing code and steps, not exhaustive " +
  "boilerplate. Keep it under ~600 words.";

export function targetSysWithSkill(skillBody: string): string {
  return (
    TARGET_SYS_BASE +
    "\n\nYou have access to the following SKILL that may help with this class of task. " +
    "Apply it where relevant:\n\n<skill>\n" +
    skillBody +
    "\n</skill>"
  );
}

// ---- Judge (BLIND to the skill: scores task success vs the reference outcome) ----
export const JUDGE_SYS =
  "You are a strict, fair evaluator of engineering solutions. You output strict JSON only. " +
  "You never see any 'skill' or hint document — you judge only whether the candidate solution " +
  "would actually accomplish the task to a standard at least as good as the reference outcome.";

export function judgeUser(taskPrompt: string, referenceOutcome: string, candidate: string): string {
  return `TASK:
${taskPrompt}

REFERENCE OUTCOME (one known-good approach that actually worked — NOT the only valid one; do not reward mere imitation, reward correctness and completeness):
${referenceOutcome}

CANDIDATE SOLUTION (to evaluate):
${candidate}

Score the candidate on whether it would correctly and completely accomplish the task in practice.
Reward: correct mechanism, completeness, verification step, avoidance of known pitfalls.
Penalize: missing/incorrect steps, would-not-actually-work, hand-waving, no verification.
Do NOT penalize stylistic differences from the reference or alternative valid approaches.

Return strict JSON (no fences):
{
  "hard": <0 or 1>,        // 1 only if the candidate would fully and correctly accomplish the task
  "soft": <float 0..1>,    // graded quality/completeness
  "rationale": "<1-3 sentences: what makes it pass/fail>"
}`;
}

// ---- Optimizer reflect (failures and successes handled separately) ----
export const REFLECT_SYS =
  "You improve a natural-language SKILL document used by an engineering agent. " +
  "You propose a small, high-leverage set of structured edits that fix recurring failure " +
  "patterns or lock in what works. You output strict JSON only.";

export function reflectUser(
  kind: "failure" | "success",
  skillBody: string,
  cases: string,
  editBudget: number,
): string {
  const intent =
    kind === "failure"
      ? "identify the most important COMMON failure patterns across these cases and propose edits that would prevent them"
      : "identify what reliably WORKED across these cases and propose edits that lock in those behaviors";
  return `You are given several ${kind} cases (task + the agent's solution + the judge's rationale) and the CURRENT skill document. Your job: ${intent}.

Budget: propose AT MOST ${editBudget} edits. Prefer general, actionable rules over narrow ones. Do not target the protected slow-update region.

Edit operations:
- {"op":"append","content":"<markdown>"}                          // add new guidance
- {"op":"insert_after","target":"<exact existing text>","content":"<markdown>"}
- {"op":"replace","target":"<exact existing text>","content":"<new text>"}
- {"op":"delete","target":"<exact existing text>"}

CURRENT SKILL:
<skill>
${skillBody}
</skill>

${kind.toUpperCase()} CASES:
${cases}

Return strict JSON (no fences):
{
  "reasoning": "<why these edits address the pattern>",
  "edits": [ ... up to ${editBudget} edit objects ... ]
}`;
}
