/**
 * Hermes driver.
 *
 * Install: `hivemind hermes install` deposits the hermes bundle + the
 * hivemind-memory skill md + the MCP server into ~/.hermes/ and
 * ~/.hivemind/mcp/ respectively.
 *
 * Non-interactive run: `hermes -z <prompt> --provider google --model X --yolo`.
 * `-z` is hermes's headless one-shot flag. `--yolo` auto-approves tool
 * calls (hermes equivalent of `--force` / `--allow-dangerously-...`).
 */

import type { AgentDriver, RunOpts, RunResult } from "../types.js";
import { runProcess } from "./claude-code.js";
import { installOrThrow } from "./install-via-cli.js";

export const hermesDriver: AgentDriver = {
  id: "hermes",
  providerKey: "GOOGLE_API_KEY",
  async install(home, repoRoot) {
    await installOrThrow("hermes", home, repoRoot);
  },
  async run(prompt, opts: RunOpts): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home,
      HIVEMIND_DEBUG: "1",
    };
    if (opts.providerEnv.GOOGLE_API_KEY) {
      env.GOOGLE_API_KEY = opts.providerEnv.GOOGLE_API_KEY;
      // Hermes also reads GEMINI_API_KEY in some versions; forward both
      // to avoid an "unauthenticated" failure on the version that's
      // installed on the runner.
      env.GEMINI_API_KEY = opts.providerEnv.GOOGLE_API_KEY;
    }
    const args = [
      "-z",
      prompt,
      "--provider", "google",
      "--model", "gemini-2.5-flash",
      "--yolo",
    ];
    return runProcess("hermes", args, env, opts.timeoutMs ?? 90_000, opts.sessionId);
  },
};
