/**
 * Cursor-agent driver.
 *
 * Install: `hivemind cursor install` copies the cursor bundle into
 * ~/.cursor/hivemind/ and registers the preToolUse + sessionStart hooks
 * via cursor's hook config.
 *
 * Non-interactive run: `cursor-agent --print --force <prompt>`. `--force`
 * auto-approves tool calls so the harness doesn't block on a prompt.
 * `--print` is the headless flag (vs the default agent TUI).
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const cursorAgentDriver: AgentDriver = {
  id: "cursor-agent",
  providerKey: "OPENAI_API_KEY",
  async install(home, repoRoot) {
    await installOrThrow("cursor", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      HIVEMIND_DEBUG: "1",
    };
    if (opts.providerEnv.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = opts.providerEnv.OPENAI_API_KEY;
      // cursor-agent reads the OpenAI key via its own auth bridge; the
      // explicit --api-key flag overrides any stale stored auth and keeps
      // the run isolated from whatever the host's `cursor-agent login`
      // last persisted.
      env.CURSOR_API_KEY = opts.providerEnv.OPENAI_API_KEY;
    }
    const args = [
      "--print",
      "--force",
      "--model",
      "gpt-5-mini",
      prompt,
    ];
    return runProcess("cursor-agent", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
