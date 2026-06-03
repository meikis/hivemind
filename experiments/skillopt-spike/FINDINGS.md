# SkillOpt → Hivemind spike: findings

Throwaway research spike (this dir is not shipped). Question: can SkillOpt's "train the skill, not the
weights" loop be integrated into hivemind, and what reward signal makes it work?

## TL;DR
- SkillOpt's reflect→edit→gate **machinery is sound** (the gate correctly accepts improvements / rejects
  regressions). The hard part is the **reward** — hivemind has no ground-truth labels, unlike SkillOpt's
  benchmarks.
- **Option A (offline correctness-judge vs an LLM-mined reference): too weak.** On a strong target (Sonnet)
  a generic skill is **redundant** (skill ≈ no-skill, ~0.000), the judge's noise floor (±0.08 soft / ±0.33
  hard) swamps the effect, and all proposed edits gated out (optimized == original, verified by diff).
- **Option B2 (success-weighted satisfaction-judge over REAL sessions): the viable signal.** Reads real
  sessions (no answer-key, no fresh rollout), model-agnostic, reliable (test-retest r=0.899), and surfaces a
  **higher-value class of skill** — real behavioral failures A structurally cannot see.

## What was built (`src/`)
- `deeplake.ts` / `orgsource.ts` — query the org Deeplake `sessions` table (166k rows / 1,367 sessions /
  14 authors) and reconstruct any session from its turn-rows.
- `dataprep*.ts` + `distill.ts` — turn real sessions into replayable `{task, referenceOutcome}`.
- `rollout.ts` `scorer.ts` `reflect.ts` `edit.ts` `gate.ts` `loop.ts` — the Option-A loop (edit-application
  is a TS port of `skillopt/optimizer/skill.py`, unit-tested).
- `satisfaction.ts` `b2-probe.ts` `b2-gradient.ts` — the B2 satisfaction-judge, its validation, and the
  textual-gradient edit extractor.
- `b2-robust.ts` `b2-adversarial.ts` `recall-probe.ts` — confidence tests.

## Key results
**A (org-scale, 12 test / 8 val / 32 train):** no-skill 0.783 = original 0.783 → optimized 0.703 (= original
text scored twice; all edits rejected). Skill adds ~0 on a strong target; noise dominates.

**B2 satisfaction-judge discriminates (n=19):** success=1→0.74 vs 0→0.36; abandoned→0.19; explicit-thanks
→0.75. Caught real thanks, a user correction, a plan-mode stall, an empty session (0.00).

**B2 gradient (4 worst real sessions → 4 skill edits):** empty-turn→"never emit an empty turn";
plan-mode paralysis→"don't let plan mode block a clear task"; late tool-failure→"check tool availability
first"; **silently merged the WRONG PR on 'merge it'**→"confirm before irreversible background actions."
All general, actionable, grounded in the user's own words.

**Confidence tests:**
- Robustness: r=0.899, mean |Δ|=0.076; rock-stable at extremes, noisy in the middle → trust the tails.
- Sycophancy: user praising a WRONG answer → satisfaction 0.85 **but success 0** (success-axis resists);
  correct-but-grumpy → 0.30 (affect false-negative); competence-aware extractor **rejects** a wrong user
  demand. ⇒ weight `success` > `satisfaction`; aggregate; competence-filter edits.
- Recall gap (corrected): the relevant skills are **local-only, not in the org table**; **140/200 local
  skills are unpropagated**. The cross-user failure is a **distribution gap**, not "ignored skill."

## Recommended integration (phased)
0. **Close the distribution gap first** (140/200 local skills never reach the org) — cheapest, no ML, would
   have prevented the observed cross-user failure.
1. **Representation (C):** edit-op schema + protected slow-update region + meta-skill (TS port ready).
2. **B2 offline proposer:** capture → success-weighted satisfaction-judge → cluster dissatisfied →
   competence-filtered edit extractor → propose edits/new skills. Cloud-side, periodic.
3. **Online A/B gate (needs deployment):** shadow candidate skill vs control on real traffic, keep iff real
   success/satisfaction improves. The only trustworthy "did it help."

## Still untested (need deployment / uncaptured data)
Whether applied edits actually improve future sessions (Phase-3 A/B); per-user injection-vs-adherence (skill
injection is in the SessionStart system prompt, which capture doesn't record); judge at full scale under real
aggregate sycophancy load.

## E2E on org-shared skills + the decisive null

Scoped to org-shared skills (`--author` / org `skills` table), per the goal of improving team skills.

- **Org-wide B2 pass** (150 sessions → 23 scored → 7 dissatisfied) routed 7 competence-filtered edit
  proposals across 5 org skills. Proposer works at org scale.
- **Offline validation does NOT work — four independent setups all ~0:** absolute-judge (A),
  pairwise+proprietary e2e (`pg-deeplake-test-crash-debugging`: skill-vs-no-skill +0.00, ablation-recovery
  −0.07), and crisp skill-relevant pairwise (−0.17). Diagnostic root cause: hivemind skills are mostly
  **behavioral/process + proprietary-context** skills whose value lives in **real multi-turn execution**
  (avoiding a bad trajectory), which a **one-shot judged "describe your solution"** cannot capture — there's
  no plan-mode-stall to prevent in a single shot. SkillOpt's loop fits verifiable one-shot-answer benchmarks
  (SearchQA); hivemind skills aren't that shape.

**Net:** the **proposer is the working, valuable half**; **offline rollout+judge cannot validate skill
improvement** for these skills. Validation requires **real/online use** (A/B skill-present vs absent on live
sessions, measuring real success/satisfaction).

## Deliverable for real-world testing
`npm run dataprep-org` (mine) → `org-optimize` (propose) → `assemble-optimized` writes, to
`out/optimized-skills/`, `original` + `optimized` markdown for 4 real org skills (goals-capture-resume-pattern
+3 rules, posthog-event-smoke-testing +1, pybind-type-stub-debugging +1, hivemind-usage-reporting +1) plus 1
proposed NEW shared skill (`execute-not-block-on-safe-read-ops`). Each edit carries a provenance comment
(source session + the failure it fixes). **To real-test:** deploy an `optimized` skill to the org, use it on
real tasks, and compare real outcomes vs the `original` — the only valid validation per the finding above.

_Approx spend across the spike: ~$85 in LLM calls. Data/outputs are gitignored (contain real session content)._
