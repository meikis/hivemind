# SkillOpt spike (THROWAWAY)

Research spike for the question: **does SkillOpt-style optimization measurably improve a real
hivemind `SKILL.md`, scored against an LLM-judge reward derived from the skill's real sessions?**

This is **not shipped code**. It's a de-risking experiment for integrating SkillOpt's
reflect→edit→gate loop into hivemind (roadmap step D). It only *reads* `ext/SkillOpt` for
patterns — nothing is imported from it.

## How it works

1. **dataprep** — turn real Claude Code session transcripts into replayable `{task, referenceOutcome}`:
   - `source` tasks: from the skill's own `source_sessions` (potential leakage)
   - `mined` tasks: other PostHog sessions found locally (leakage-free → used for TEST)
2. **calibrate** — sanity-check the judge: it must score a known-good answer high and an
   obviously-bad one low, or the deltas are meaningless.
3. **run** — measure on a held-out TEST split: `no-skill` → `original skill` → run the
   reflect→edit→gate loop → `optimized skill`. Headline = **optimized vs original**.

LLM calls shell out to the `claude` CLI (same pattern hivemind's gate uses), so it uses whatever
models Claude Code resolves. Roles (target / optimizer / judge / dataprep) and all hyperparameters
are configurable via env vars — see `src/config.ts`.

## Run

```bash
cd experiments/skillopt-spike
npm run dataprep    # build data/tasks.json from real sessions
npm run calibrate   # validate the judge discriminates
npm run run         # the spike; writes out/results.json + out/optimized_skill.md
```

## What this is NOT

- Not a benchmark (small N; the point is signal, not a leaderboard).
- Slow-update / meta-skill / aggregation are deferred (not needed to answer the core question).
- The judge is one (noisy) reward; the `Scorer` interface (`src/scorer.ts`) is the part that
  ports forward — outcome-heuristics / human feedback can implement the same shape.
