/**
 * Heuristic "anchor" — a HARD, observable signal in the transcript that a session
 * went badly, independent of any LLM judgment: the user pushed back on / corrected
 * what the assistant just did. Pure + free (no LLM, no I/O).
 *
 * It's the level-1 filter in the outcome pipeline: only windows with an anchor go
 * to the (paid) success-judge, and a session is labelled a failure only when the
 * anchor AND the judge agree. So this is deliberately tuned for RECALL over
 * precision — a false positive just costs one judge call (which then drops it),
 * but a false negative under-detects (conservative — it never churns a good skill).
 * Patterns are meant to be tuned against real sessions; this is a starting set.
 */
import type { Turn } from "./skill-invocations.js";

export type AnchorKind = "correction" | "none";
export interface Anchor {
  anchored: boolean;
  kind: AnchorKind;
  evidence: string; // the user turn that triggered it (truncated)
}

// User pushback: rejection / correction of what the assistant just produced.
const PUSHBACK = /\b(no|nope|wrong|incorrect|not what|that'?s not|does ?n'?t work|did ?n'?t work|do ?n'?t work|wo ?n'?t work|is ?n'?t|that'?s wrong|broke|broken|still (failing|broken|not working|wrong|the same)|try again|undo|revert that|that fail)/i;

// Clear benign negatives we don't want to fire on (keeps obvious false positives
// out of the judge to save tokens). Intentionally narrow — when in doubt, fire.
const BENIGN = /\b(no (problem|worries|need|biggie)|no,? thanks|all good|works? (now|great|fine|perfectly)|that works|perfect|looks good|thank)/i;

/**
 * Detect a correction anchor in a windowed slice of turns. Only a USER turn that
 * immediately follows an ASSISTANT turn can be pushback (the first user turn is
 * the request, not a reaction).
 */
export function detectAnchor(turns: Turn[]): Anchor {
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "USER" || turns[i - 1].role !== "ASSISTANT") continue;
    if (PUSHBACK.test(t.text) && !BENIGN.test(t.text)) {
      return { anchored: true, kind: "correction", evidence: t.text.slice(0, 200) };
    }
  }
  return { anchored: false, kind: "none", evidence: "" };
}
