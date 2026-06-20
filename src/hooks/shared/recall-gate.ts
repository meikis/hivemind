/**
 * Proactive-recall gate — decides whether a user prompt is worth a memory
 * search BEFORE paying for one.
 *
 * Searching on every prompt is wrong: most turns are acks/continuations with
 * no relevant memory, so an unconditional search adds latency to every turn
 * and injects low-relevance noise that trains the model to ignore the block.
 * This gate keeps the expensive path (embed + vector query) rare and
 * high-precision. Bias: when in doubt, SKIP — a missed recall is invisible,
 * a noisy injection every turn is actively annoying.
 *
 * Pure + side-effect-free so it is exhaustively unit-testable; all tuning
 * lives in the exported constants.
 */

/** Cosine score (0..1, higher = closer) a hit must clear to be injected. */
export const RECALL_THRESHOLD = 0.55;

/** Minimum substantive prompt length (chars) before we consider searching. */
const MIN_PROMPT_CHARS = 24;
/** Minimum word count for the "substantive prose" path. */
const MIN_PROMPT_WORDS = 6;

// Short acknowledgements / continuations — never recall-worthy on their own.
const ACK_RE =
  /^(y|n|yes|yep|yeah|no|nope|ok|okay|kk|k|sure|go|go on|go ahead|continue|cont|proceed|next|do it|please do|thanks|thank you|ty|thx|nice|great|perfect|cool|done|stop|wait|hold on|undo|revert|retry|try again|again|run it|run them|rerun|fix it|fix that|fix this|same|yep do it)\b[\s.!?]*$/i;

// High-signal intent/event markers — strong reason to check prior work.
const SIGNAL_RES: RegExp[] = [
  // Errors / failures / stack traces
  /\b(error|exception|traceback|stack ?trace|panic|segfault|sigsegv|sigabrt|assertion|failed|failing|crash(ed|ing)?|throws?|undefined|null pointer|cannot find|not found|unresolved|deadlock|timeout|oom|leak)\b/i,
  /\b[\w./-]+:\d+(:\d+)?\b/, // file:line(:col) reference
  /\b[A-Z][A-Za-z0-9]*(Error|Exception)\b/, // TypeError, FooException
  // Recall / continuity intent
  /\b(remember|recall|last time|previously|before|earlier|we (did|used|tried|decided|chose|hit|saw|had)|did we|have we|how did we|what did we|where did we|known issue|again)\b/i,
  // Question / how-to intent
  /\b(how (do|to|can|should)|why (does|is|are|did)|what(?:'s| is| are)|where (is|are|do)|which|when should)\b/i,
];

export interface RecallDecision {
  /** Whether to run the memory search for this prompt. */
  recall: boolean;
  /** Short machine reason (telemetry): "ack" | "too-short" | "signal" | "substantive" | "low-signal". */
  reason: string;
}

/**
 * Decide whether `prompt` warrants a proactive memory search.
 * Layer 0 (cheap reject): empty / very short / acknowledgement.
 * Layer 1 (signal gate): error/intent markers, else substantive prose only.
 */
export function shouldRecall(prompt: string | undefined | null): RecallDecision {
  const text = (prompt ?? "").trim();
  if (text.length < MIN_PROMPT_CHARS) return { recall: false, reason: "too-short" };
  if (ACK_RE.test(text)) return { recall: false, reason: "ack" };
  if (SIGNAL_RES.some((re) => re.test(text))) return { recall: true, reason: "signal" };
  // No explicit signal — only search genuinely substantive prose (a real
  // request/description), not a terse mid-task instruction.
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= MIN_PROMPT_WORDS) return { recall: true, reason: "substantive" };
  return { recall: false, reason: "low-signal" };
}

/** True when a hit's cosine score clears the injection threshold. */
export function passesThreshold(score: number, threshold: number = RECALL_THRESHOLD): boolean {
  return Number.isFinite(score) && score >= threshold;
}
