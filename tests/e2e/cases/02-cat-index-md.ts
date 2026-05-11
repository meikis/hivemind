/**
 * cat /index.md works through the virtual mount.
 *
 * The agent is asked to read the synthesized memory index. With the
 * memory-mount intercept wired correctly, `cat ~/.deeplake/memory/index.md`
 * returns a bounded markdown table from the SQL fast-path. Without it,
 * the agent shells out to the real FS and gets ENOENT.
 *
 * We assert that the agent's stdout contains the index's table header
 * (which the synthesized markdown always emits). The exact header text
 * is stable across versions — we anchor on the `Created` / `Last Updated`
 * column names that the virtual index always renders.
 *
 * Skip claude-code only if a real index can't be synthesized — currently
 * none of the tier-1 agents need to be skipped; the virtual mount is
 * uniformly wired.
 */

import type { E2ECase } from "../types.js";

export const catIndexMdCase: E2ECase = {
  id: "02-cat-index-md",
  description:
    "agent shells `cat ~/.deeplake/memory/index.md` and the virtual mount returns the index table",
  prompt:
    "Run exactly this bash command and show me its full output, then say 'done':\n" +
    "cat ~/.deeplake/memory/index.md",
  assertions: [
    {
      type: "hook-log-contains",
      substring: "direct read: /index.md",
      label: "pre-tool-use intercepted /index.md",
    },
    {
      type: "stdout-matches",
      regex: /Last Updated|Created|Project|Description/,
      label: "agent saw the virtual index's table headers",
    },
  ],
};
