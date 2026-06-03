// Shared: distill a condensed session into a replayable {task, referenceOutcome}.
// Used by both local-file dataprep and org-sessions dataprep.
import { callLLM, extractJson } from "./llm.ts";
import { DATAPREP_SYS, dataprepUser } from "./prompts.ts";
import type { Task } from "./types.ts";

export async function distillText(
  condensed: string,
  id: string,
  provenance: "source" | "mined",
): Promise<Task | null> {
  if (condensed.length < 200) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const suffix = attempt === 0 ? "" : "\n\nReturn ONLY the JSON object. No prose, no markdown, no headings.";
    try {
      const { text } = await callLLM("dataprep", DATAPREP_SYS, dataprepUser(condensed) + suffix);
      const p = extractJson<{ posthog_relevant: boolean; task_prompt: string; reference_outcome: string }>(text);
      return {
        id,
        taskPrompt: p.task_prompt,
        referenceOutcome: p.reference_outcome,
        posthogRelevant: !!p.posthog_relevant,
        provenance,
      };
    } catch {
      if (attempt === 1) return null;
    }
  }
  return null;
}
