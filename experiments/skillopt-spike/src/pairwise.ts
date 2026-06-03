// Robust validation gate: pairwise preference (optimized skill vs original) on a
// held-out task. Pairwise is far lower-variance than absolute soft-scoring (which had
// a ±0.08 noise floor). Position bias is corrected by judging BOTH orders and combining.
import { callLLM, extractJson } from "./llm.ts";

const PW_SYS =
  "You compare two candidate solutions to the same engineering task and decide which would better " +
  "accomplish it in practice. You are decisive. You output strict JSON only.";

function pwUser(task: string, reference: string, a: string, b: string): string {
  return `TASK:
${task}

REFERENCE OUTCOME (one known-good result — not the only valid one; reward correctness/completeness, not imitation):
${reference}

SOLUTION A:
${a}

SOLUTION B:
${b}

Which solution would more correctly and completely accomplish the task? Reward correct mechanism,
completeness, verification, and avoiding known pitfalls. Ignore length and style differences.
Return strict JSON (no fences): {"winner":"A"|"B"|"tie","reason":"<one sentence>"}`;
}

async function judgeOnce(task: string, reference: string, a: string, b: string): Promise<"A" | "B" | "tie"> {
  const { text } = await callLLM("judge", PW_SYS, pwUser(task, reference, a, b));
  const p = extractJson<{ winner: string }>(text);
  const w = String(p.winner).toUpperCase();
  return w === "A" ? "A" : w === "B" ? "B" : "tie";
}

// Returns optScore in [-1,1]: +1 = optimized clearly better in BOTH orders, -1 = original better,
// 0 = tie or inconsistent (position-bias flagged). Judging both orders cancels position bias.
export async function pairwise(
  task: string,
  reference: string,
  solOrig: string,
  solOpt: string,
): Promise<number> {
  const r1 = await judgeOnce(task, reference, solOrig, solOpt); // A=orig, B=opt
  const r2 = await judgeOnce(task, reference, solOpt, solOrig); // A=opt, B=orig
  const s1 = r1 === "B" ? 1 : r1 === "A" ? -1 : 0; // opt was B
  const s2 = r2 === "A" ? 1 : r2 === "B" ? -1 : 0; // opt was A
  return (s1 + s2) / 2;
}
