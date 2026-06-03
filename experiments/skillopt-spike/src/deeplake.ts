// Minimal Deeplake query client — replicates hivemind's src/deeplake-api.ts query()
// contract (POST /workspaces/{ws}/tables/query, body {query}, resp {columns,rows}).
// Reads the same credentials hivemind writes at ~/.deeplake/credentials.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Creds { token: string; orgId: string; workspaceId: string; apiUrl: string }
const creds: Creds = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".deeplake/credentials.json"), "utf8"),
);

export const SESSIONS_TABLE = process.env.HIVEMIND_SESSIONS_TABLE || "sessions";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dquery(sql: string): Promise<Record<string, unknown>[]> {
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(`${creds.apiUrl}/workspaces/${creds.workspaceId}/tables/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
          "X-Activeloop-Org-Id": creds.orgId,
          "X-Activeloop-Client-Name": "skillopt-spike",
        },
        body: JSON.stringify({ query: sql }),
      });
    } catch (e) {
      lastErr = (e as Error).message;
      await sleep(800 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    if (resp.ok) {
      const raw = (await resp.json()) as { columns?: string[]; rows?: unknown[][] } | null;
      if (!raw?.rows || !raw?.columns) return [];
      return raw.rows.map((row) => Object.fromEntries(raw.columns!.map((c, i) => [c, row[i]])));
    }
    lastErr = `query ${resp.status}: ${(await resp.text()).slice(0, 160)}`;
    if (!RETRYABLE.has(resp.status) || attempt === 4) throw new Error(lastErr);
    await sleep(800 * 2 ** attempt + Math.random() * 300);
  }
  throw new Error(lastErr || "dquery failed");
}
