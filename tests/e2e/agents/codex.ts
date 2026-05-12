/**
 * Codex driver.
 *
 * Install: `hivemind codex install` copies the codex bundle into
 * ~/.codex/hivemind/ and writes ~/.codex/hooks.json. No marketplace
 * round-trip — pure local copy.
 *
 * Non-interactive run: `codex exec <prompt>`. Codex prints its final
 * answer + a usage line to stdout. Session_id is logged by the hivemind
 * hooks to ~/.deeplake/hook-debug.log, same as claude-code.
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const codexDriver: AgentDriver = {
  id: "codex",
  providerKey: "OPENAI_API_KEY",
  async install(home, repoRoot) {
    await installOrThrow("codex", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      HIVEMIND_DEBUG: "1",
    };
    if (opts.providerEnv.OPENAI_API_KEY) {
      env.OPENAI_API_KEY = opts.providerEnv.OPENAI_API_KEY;
    }
    // `codex exec` is the explicit non-interactive subcommand. Without
    // it, codex falls into its interactive TUI and blocks on stdin.
    // `-m` picks the model; we use gpt-5-mini as the cheap default.
    const args = ["exec", "-m", "gpt-5-mini", prompt];
    return runProcess("codex", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
