/**
 * Shared installer-dispatch helper. Codex / Cursor / Hermes / Pi all install
 * hivemind by copying bundle files into agent-specific paths under HOME and
 * writing one config file (hooks.json / extension wiring / skill md). That's
 * exactly what `hivemind <agent> install` already does, so we just shell out
 * to it with HOME overridden to the tmp sandbox.
 *
 * We deliberately do NOT import installXxx() functions directly into the
 * runner. Reason: those installers capture `homedir()` at MODULE LOAD time
 * (see src/cli/util.ts:HOME). A spawned subprocess starts fresh and picks
 * up our HOME override; an in-process require/import would use the runner's
 * own HOME, not the tmp sandbox.
 *
 * Claude Code does NOT use this — its driver passes `--plugin-dir` directly
 * to the `claude` CLI, which loads the plugin for the session only and
 * avoids `claude plugin marketplace add`'s network round-trip.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface InstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `hivemind <agent> install` against the given HOME. Resolves with the
 * subprocess's exit code; caller decides whether to throw.
 *
 * `agentArg` is the CLI subcommand name, which differs slightly from our
 * internal AgentId for openclaw (`claw` not `openclaw`). For the five
 * tier-1 agents the mapping is identity.
 */
export function runInstallerSubprocess(
  agentArg: string,
  home: string,
  repoRoot: string,
  timeoutMs = 60_000,
): Promise<InstallResult> {
  const cliEntry = resolve(repoRoot, "src", "cli", "index.ts");
  return new Promise((resolveP) => {
    const child = spawn(
      "npx",
      ["--yes", "tsx", cliEntry, agentArg, "install"],
      {
        env: { ...process.env, HOME: home },
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      resolveP({ exitCode: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolveP({ exitCode: -1, stdout, stderr: `${stderr}\nspawn error: ${err.message}` });
    });
  });
}

/** Throw if install didn't exit cleanly. Used by every non-claude driver. */
export async function installOrThrow(agentArg: string, home: string, repoRoot: string): Promise<void> {
  const r = await runInstallerSubprocess(agentArg, home, repoRoot);
  if (r.exitCode !== 0) {
    throw new Error(
      `\`hivemind ${agentArg} install\` failed (exit=${r.exitCode}). stderr:\n${r.stderr.slice(-800)}`,
    );
  }
}
