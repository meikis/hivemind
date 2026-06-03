// Optimizer "backward pass": read scored rollouts, propose bounded structured edits.
import { callLLM, extractJson } from "./llm.ts";
import { REFLECT_SYS, reflectUser } from "./prompts.ts";
import type { Edit, Patch, Task, Score } from "./types.ts";

export interface ScoredRollout {
  task: Task;
  output: string;
  score: Score;
}

function formatCases(rolls: ScoredRollout[]): string {
  return rolls
    .map((r, i) => {
      const out = r.output.length > 1800 ? r.output.slice(0, 1800) + "\n…[truncated]" : r.output;
      return `### Case ${i + 1} (hard=${r.score.hard}, soft=${r.score.soft.toFixed(2)})
TASK: ${r.task.taskPrompt.slice(0, 700)}
AGENT SOLUTION:
${out}
JUDGE: ${r.score.rationale}`;
    })
    .join("\n\n");
}

export async function reflect(
  kind: "failure" | "success",
  skillBody: string,
  rolls: ScoredRollout[],
  editBudget: number,
): Promise<Patch & { costUsd: number }> {
  if (rolls.length === 0) return { reasoning: "no cases", edits: [], costUsd: 0 };
  const base = reflectUser(kind, skillBody, formatCases(rolls), editBudget);
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose, no markdown.";
    const { text, costUsd } = await callLLM("optimizer", REFLECT_SYS, base + suffix);
    cost += costUsd;
    try {
      const p = extractJson<{ reasoning: string; edits: Edit[] }>(text);
      const edits = (Array.isArray(p.edits) ? p.edits : []).slice(0, editBudget).map((e) => ({
        ...e,
        source_type: kind,
      }));
      return { reasoning: String(p.reasoning ?? ""), edits, costUsd: cost };
    } catch {
      if (attempt === 1) return { reasoning: "reflect parse failed", edits: [], costUsd: cost };
    }
  }
  return { reasoning: "reflect parse failed", edits: [], costUsd: cost };
}
