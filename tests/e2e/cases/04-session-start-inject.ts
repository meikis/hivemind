/**
 * SessionStart inject is visible in the agent's response context.
 *
 * Each agent's SessionStart hook injects a long block about how to
 * search ~/.deeplake/memory/ (the 3-tier explanation: index.md /
 * summaries/ / sessions/). The agent never sees the literal hook output
 * — it's wrapped into the agent's developer context by the runtime. So
 * the only behavioral signal we can check is: when asked what tiered
 * memory layout it has been told about, does the agent's answer reflect
 * the injected text?
 *
 * Anchoring on three independently-stable strings: "THREE tiers",
 * "index.md", "summaries". If any of them is missing from the agent's
 * reply, either the inject didn't fire or the runtime stripped it.
 */

import type { E2ECase } from "../types.js";

export const sessionStartInjectCase: E2ECase = {
  id: "04-session-start-inject",
  description:
    "agent's session-start inject is reflected back when asked about the memory layout",
  prompt:
    "Without running any tools, describe the three tiers of the ~/.deeplake/memory/ layout that your session-start instructions told you about. Mention each tier by filename.",
  assertions: [
    {
      type: "stdout-matches",
      regex: /index\.md/i,
      label: "agent recalls index.md tier",
    },
    {
      type: "stdout-matches",
      regex: /summaries/i,
      label: "agent recalls summaries/ tier",
    },
    {
      type: "stdout-matches",
      regex: /sessions|jsonl/i,
      label: "agent recalls sessions/ (or .jsonl) tier",
    },
  ],
};
