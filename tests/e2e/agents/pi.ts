/**
 * Pi driver.
 *
 * Install: `hivemind pi install` copies pi/extension-source/hivemind.ts
 * into ~/.pi/agent/extensions/ and writes AGENTS.md so pi picks it up.
 * Pi compiles the .ts extension at session start; no precompiled bundle.
 *
 * Non-interactive run: `pi --print --provider google --model X <prompt>`.
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const piDriver: AgentDriver = {
  id: "pi",
  providerKey: "GOOGLE_API_KEY",
  async install(home, repoRoot) {
    await installOrThrow("pi", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      HIVEMIND_DEBUG: "1",
    };
    if (opts.providerEnv.GOOGLE_API_KEY) {
      env.GOOGLE_API_KEY = opts.providerEnv.GOOGLE_API_KEY;
      env.GEMINI_API_KEY = opts.providerEnv.GOOGLE_API_KEY;
    }
    const args = [
      "--print",
      "--provider", "google",
      "--model", "gemini-2.5-flash",
      prompt,
    ];
    return runProcess("pi", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
