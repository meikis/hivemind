// Pluggable reward. The spike uses an LLM-judge; the interface is what matters
// for porting — outcome-heuristics / human feedback can implement the same shape later.
import { callLLM, extractJson } from "./llm.ts";
import { JUDGE_SYS, judgeUser } from "./prompts.ts";
import type { Task, Score } from "./types.ts";

export interface ScoredResult extends Score {
  costUsd: number;
}

export interface Scorer {
  name: string;
  score(task: Task, candidate: string): Promise<ScoredResult>;
}

export const llmJudgeScorer: Scorer = {
  name: "llm-judge",
  async score(task, candidate) {
    const { text, costUsd } = await callLLM(
      "judge",
      JUDGE_SYS,
      judgeUser(task.taskPrompt, task.referenceOutcome, candidate),
    );
    const p = extractJson<{ hard: number; soft: number; rationale: string }>(text);
    return {
      hard: (p.hard ? 1 : 0) as 0 | 1,
      soft: Math.max(0, Math.min(1, Number(p.soft))),
      rationale: String(p.rationale ?? ""),
      costUsd,
    };
  },
};

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
