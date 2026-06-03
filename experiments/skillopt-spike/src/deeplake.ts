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

export async function dquery(sql: string): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`${creds.apiUrl}/workspaces/${creds.workspaceId}/tables/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "X-Activeloop-Org-Id": creds.orgId,
      "X-Activeloop-Client-Name": "skillopt-spike",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!resp.ok) throw new Error(`query ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const raw = (await resp.json()) as { columns?: string[]; rows?: unknown[][] } | null;
  if (!raw?.rows || !raw?.columns) return [];
  return raw.rows.map((row) => Object.fromEntries(raw.columns!.map((c, i) => [c, row[i]])));
}
