// B2-real: a success/satisfaction judge that reads a REAL session transcript and
// scores how it went FOR THE USER — from the user's actual reactions, with no
// answer-key and no fresh rollout. This is the instrument that sidesteps both the
// "redundant on strong target" and "needs a mined reference" problems of Option A.
import { callLLM, extractJson } from "./llm.ts";

export const SAT_SYS =
  "You evaluate whether a real AI-assistant engineering session ended well for the user. " +
  "You read the actual transcript and judge ONLY from evidence in it — the user's reactions, " +
  "corrections, follow-ups, and whether the task got resolved. You output strict JSON only.";

export interface SatScore {
  success: 0 | 1;
  satisfaction: number; // 0..1
  signals: {
    user_corrected: boolean;
    user_repeated: boolean;
    user_frustrated: boolean;
    user_satisfied_explicit: boolean;
    task_abandoned: boolean;
  };
  rationale: string;
}

export function satUser(sessionText: string): string {
  return `Below is a REAL assistant session transcript (USER and ASSISTANT turns; tool noise removed).
Judge how it went FOR THE USER, using ONLY evidence in the transcript — what the user actually said,
whether they had to correct or repeat themselves, whether they expressed approval or frustration, and
whether their task ended resolved.

Return strict JSON (no fences):
{
  "success": <0 or 1>,            // did the user's task actually get resolved by the end
  "satisfaction": <float 0..1>,   // how satisfied the user seemed by the end
  "signals": {
    "user_corrected": <true|false>,           // user had to correct/redirect the assistant
    "user_repeated": <true|false>,            // user re-asked the same thing (assistant missed it)
    "user_frustrated": <true|false>,          // visible frustration
    "user_satisfied_explicit": <true|false>,  // explicit thanks/approval ("perfect", "works", "thanks")
    "task_abandoned": <true|false>            // user gave up / left it unresolved
  },
  "rationale": "<1-2 sentences citing concrete evidence from the transcript>"
}

TRANSCRIPT:
${sessionText}`;
}

export async function satisfactionJudge(sessionText: string): Promise<SatScore & { costUsd: number }> {
  const { text, costUsd } = await callLLM("judge", SAT_SYS, satUser(sessionText));
  const p = extractJson<SatScore>(text);
  return {
    success: (p.success ? 1 : 0) as 0 | 1,
    satisfaction: Math.max(0, Math.min(1, Number(p.satisfaction))),
    signals: {
      user_corrected: !!p.signals?.user_corrected,
      user_repeated: !!p.signals?.user_repeated,
      user_frustrated: !!p.signals?.user_frustrated,
      user_satisfied_explicit: !!p.signals?.user_satisfied_explicit,
      task_abandoned: !!p.signals?.task_abandoned,
    },
    rationale: String(p.rationale ?? ""),
    costUsd,
  };
}

// Lexical cross-check: surface gratitude vs frustration cues in the USER turns only.
// Used to validate the judge's satisfaction score tracks real surface signals.
export function lexicalSignal(sessionText: string): { grat: number; frust: number; net: number } {
  const userText = sessionText
    .split("\n")
    .filter((l) => l.startsWith("USER:"))
    .join("\n")
    .toLowerCase();
  const grat = (userText.match(/\b(thanks|thank you|perfect|great|works now|awesome|nailed it|exactly|lgtm)\b/g) || []).length;
  const frust = (userText.match(/\b(no,|nope|wrong|still (broken|failing|not)|doesn'?t work|that'?s not|not what|undo|revert|stop|ugh|why (is|does)|broken)\b/g) || []).length;
  return { grat, frust, net: grat - frust };
}
