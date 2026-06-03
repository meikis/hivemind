// Thin LLM client: shells out to the `claude` CLI in headless print mode.
// This mirrors how hivemind's skillify gate actually invokes models, and means
// the harness uses whatever agent/models the user has (Claude Code -> Claude).
import { spawn } from "node:child_process";
import { MODELS } from "./config.ts";

// Run the claude CLI with stdin CLOSED (stdio ignore) so it never blocks
// waiting for piped input, and a hard timeout that actually kills the child.
function runClaude(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
    });
  });
}

export type Role = keyof typeof MODELS;

// Force pure-text generation: deny every tool so a "rollout" produces the
// artifact as text instead of actually executing against the filesystem/network.
const DISALLOWED = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch",
  "WebSearch", "Task", "NotebookEdit", "TodoWrite", "MultiEdit",
];

let totalCostUsd = 0;
let totalCalls = 0;
export const costSoFar = () => totalCostUsd;
export const callsSoFar = () => totalCalls;

export interface LLMResult {
  text: string;
  costUsd: number;
}

export async function callLLM(
  role: Role,
  systemPrompt: string,
  userPrompt: string,
): Promise<LLMResult> {
  // --system-prompt REPLACES Claude Code's default agent prompt (cheaper + clean control).
  // Variadic --disallowed-tools must come last so it doesn't swallow later flags.
  const args = [
    "-p", userPrompt,
    "--model", MODELS[role],
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", systemPrompt,
    "--disallowed-tools", ...DISALLOWED,
  ];
  const stdout = await runClaude(args, 180_000);
  const parsed = JSON.parse(stdout);
  const costUsd = Number(parsed.total_cost_usd ?? 0);
  totalCostUsd += costUsd;
  totalCalls += 1;
  if (parsed.is_error) {
    throw new Error(`claude returned error: ${String(parsed.result).slice(0, 300)}`);
  }
  return { text: String(parsed.result ?? ""), costUsd };
}

// Extract a JSON object from a model response (tolerates ```json fences / prose).
export function extractJson<T = unknown>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s) as T;
}
