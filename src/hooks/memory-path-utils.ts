import { homedir } from "node:os";
import { join } from "node:path";

export const MEMORY_PATH = join(homedir(), ".deeplake", "memory");
export const TILDE_PATH = "~/.deeplake/memory";
export const HOME_VAR_PATH = "$HOME/.deeplake/memory";

export const SAFE_BUILTINS = new Set([
  "cat", "ls", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod",
  "stat", "readlink", "du", "tree", "file",
  // sed and awk removed: sed supports `-e '1e <cmd>'` (execute shell command)
  // and awk supports `system()` / `|` pipelines — both enable arbitrary code
  // execution through the just-bash fallback.
  "grep", "egrep", "fgrep", "rg", "cut", "tr", "sort", "uniq",
  "wc", "head", "tail", "tac", "rev", "nl", "fold", "expand", "unexpand",
  "paste", "join", "comm", "column", "diff", "strings", "split",
  // xargs removed: it executes its input as a child command (`… | xargs curl`).
  // `find` stays because the VFS serves `find -name`, but isSafe() rejects the
  // command-dispatching `-exec/-execdir/-ok/-okdir` primaries below.
  "find", "which",
  "jq", "yq", "xan", "base64", "od",
  // tar removed: --to-command=<cmd> executes an arbitrary program per entry.
  // env removed: `env <cmd>` runs an arbitrary program.
  "gzip", "gunzip", "zcat",
  "md5sum", "sha1sum", "sha256sum",
  "echo", "printf", "tee",
  "pwd", "cd", "basename", "dirname", "printenv", "hostname", "whoami",
  // timeout and time removed: both are wrappers that run an arbitrary child
  // command (`timeout 1 curl …`, `time curl …`).
  "date", "seq", "expr", "sleep", "true", "false", "test",
  "alias", "unalias", "history", "help", "clear",
  // Shell control keywords removed: as a stage's first token they let a child
  // command ride in as a later token (`if true; then curl …; fi` splits into a
  // `then curl …` stage whose leading `then` would otherwise pass). No VFS
  // handler emulates control flow, so dropping them only sends such commands to
  // the guidance/deny path — they never reach a real shell.
]);

export function isSafe(cmd: string): boolean {
  // $'...' is ANSI-C quoting: bash expands escape sequences inside it before
  // the child process sees them, bypassing the single-quote stripping below.
  if (/\$\(|`|<\(|\$'/.test(cmd)) return false;
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // `find … -exec/-execdir/-ok/-okdir <cmd>` runs an arbitrary program per
  // match. `find` itself must stay allowlisted for the `-name` read shape, so
  // reject the command-dispatching primaries explicitly. Checked post-strip so
  // a quoted grep pattern containing "-exec" can't trip a false positive.
  if (/(?:^|\s)-(?:exec|execdir|ok|okdir)\b/.test(stripped)) return false;
  // Note: we deliberately do NOT split on a bare `&` — it collides with fd
  // redirections like `2>&1`. A backgrounded second command (`cat x & curl …`)
  // still can't reach the host: it matches no handler, so it falls through to
  // the retry-guidance path which rewrites it to a harmless echo.
  const stages = stripped.split(/\||;|&&|\|\||\n/);
  for (const stage of stages) {
    const firstToken = stage.trim().split(/\s+/)[0] ?? "";
    if (firstToken && !SAFE_BUILTINS.has(firstToken)) return false;
  }
  return true;
}

export function touchesMemory(p: string): boolean {
  return p.includes(MEMORY_PATH) || p.includes(TILDE_PATH) || p.includes(HOME_VAR_PATH);
}

export function rewritePaths(cmd: string): string {
  return cmd
    .replace(new RegExp(MEMORY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "/")
    .replace(/~\/.deeplake\/memory\/?/g, "/")
    .replace(/\$HOME\/.deeplake\/memory\/?/g, "/")
    .replace(/"\$HOME\/.deeplake\/memory\/?"/g, '"/"');
}
