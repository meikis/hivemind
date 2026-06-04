import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

import { safeEchoCommand } from "../../src/hooks/pre-tool-use.js";

/** Run a generated decision command through a real shell, return its stdout. */
function runVia(shell: string, cmd: string): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(shell, ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, stderr: "" };
  } catch (e) {
    // execFileSync throws on non-zero exit; we still want stdout/stderr.
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("safeEchoCommand — body emitted verbatim, no shell interpretation", () => {
  // The exact text that broke production: backtick-wrapped find/ inside index.md
  // caused `echo "...\`find/\`..."` to run `find/` as a command (stderr noise)
  // AND eat the content. safeEchoCommand must emit it literally with no stderr.
  const cases: Array<[string, string]> = [
    ["backticks (the real bug)", "a digit from a prior `find/` (e.g. 3)."],
    ["dollar var", "cost is $PATH and ${HOME} literally"],
    ["double quotes", 'a node showing "Incoming (0)" is not dead code'],
    ["single quotes", "it's a teammate's snapshot"],
    ["percent (printf format)", "100% done, %s and %d are literal"],
    ["backslashes", "path\\to\\thing and a \\n that is two chars"],
    ["multi-line", "# Title\n\nline 2\n  indented\nlast"],
    ["mixed nasties", "`cmd` $x \"q\" 'a' 100% \\z\nsecond line"],
  ];

  for (const shell of ["/bin/bash", "/bin/sh"]) {
    describe(shell, () => {
      for (const [name, body] of cases) {
        it(`emits ${name} verbatim (+ trailing newline), no stderr`, () => {
          const { stdout, stderr } = runVia(shell, safeEchoCommand(body));
          expect(stdout).toBe(body + "\n");
          expect(stderr).toBe("");
        });
      }
    });
  }

  it("a backtick body produces NO 'No such file or directory' (the prod symptom)", () => {
    const { stdout, stderr } = runVia("/bin/bash", safeEchoCommand("see `query/` and `find/` below"));
    expect(stdout).toContain("`query/`");
    expect(stdout).toContain("`find/`");
    expect(stderr).not.toMatch(/No such file or directory/);
  });
});
