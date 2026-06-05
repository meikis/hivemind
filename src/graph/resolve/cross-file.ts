/**
 * Cross-file call resolution (Phase 1.5).
 *
 * The per-file TypeScript extractor resolves `calls` edges only WITHIN a file
 * and records every other call site as a RawCall plus the file's ImportBindings
 * (see src/graph/extract/typescript.ts). This module runs AFTER all files are
 * extracted and turns those raw calls into cross-file `calls` edges, using
 * deterministic, AST-only evidence — no LSP, no type checker, no LLM.
 *
 * Resolution is intentionally HIGH-CONFIDENCE only. We emit an edge when:
 *   - `foo()`     and `foo` is a NAMED import (incl. `as` alias) from a
 *                 resolvable local file whose matching export exists, OR
 *   - `ns.foo()`  and `ns` is `import * as ns from "./local"` and the local
 *                 file exports `foo`.
 * We DELIBERATELY skip (Phase 1.5b+):
 *   - DEFAULT imports — we don't record which export is `default`, so we can't
 *     bind one without risking a wrong edge to a NAMED export,
 *   - bare-specifier imports (node_modules / non-relative) — not our code,
 *   - tsconfig path aliases — needs tsconfig resolution,
 *   - barrel re-exports (`export * from`) — needs export-graph following,
 *   - `obj.foo()` instance dispatch, dynamic `import()`, `require()`.
 *
 * Every emitted edge is `confidence: "EXTRACTED"` because the binding + export
 * are both concrete AST facts. Ambiguous cases are dropped, not guessed.
 */

import { posix } from "node:path";

import type { FileExtraction, GraphEdge, GraphNode, ImportBinding } from "../types.js";

/** Node kinds that can be a top-level importable export. */
const EXPORTABLE_KINDS = new Set<GraphNode["kind"]>([
  "function", "class", "const", "interface", "type_alias", "enum",
]);

/** Node kinds that can appear as an `extends`/`implements` base type. */
const HERITAGE_KINDS = new Set<GraphNode["kind"]>([
  "class", "interface", "type_alias", "enum",
]);

/** Build source_file -> (exported symbol name -> node id) over exported top-level nodes. */
function buildExportIndex(nodes: readonly GraphNode[]): Map<string, Map<string, string>> {
  const idx = new Map<string, Map<string, string>>();
  for (const n of nodes) {
    if (!n.exported || !EXPORTABLE_KINDS.has(n.kind)) continue;
    let m = idx.get(n.source_file);
    if (!m) { m = new Map(); idx.set(n.source_file, m); }
    if (!m.has(n.label)) m.set(n.label, n.id); // first wins (no clashes in valid TS)
  }
  return idx;
}

/**
 * Resolve cross-file `calls` edges from the per-file extractions.
 *
 * @param extractions  every file's extraction (carrying raw_calls + import_bindings)
 * @param nodes        the aggregated node set (used to build the export index)
 * @returns            new cross-file `calls` edges (deduped); never throws
 */
export function resolveCrossFileCalls(
  extractions: readonly FileExtraction[],
  nodes: readonly GraphNode[],
): GraphEdge[] {
  const knownFiles = new Set<string>();
  for (const ex of extractions) knownFiles.add(ex.source_file);

  const exportIndex = buildExportIndex(nodes);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>(); // dedup key: source\0target

  for (const ex of extractions) {
    const rawCalls = ex.raw_calls ?? [];
    const bindings = ex.import_bindings ?? [];
    if (rawCalls.length === 0 || bindings.length === 0) continue;

    const byLocal = new Map<string, ImportBinding>();
    for (const b of bindings) {
      // First binding for a local name wins (duplicate locals are invalid TS).
      if (!byLocal.has(b.local_name)) byLocal.set(b.local_name, b);
    }

    for (const rc of rawCalls) {
      const target = resolveOne(rc, byLocal, ex.source_file, knownFiles, exportIndex);
      if (target === null) continue;
      const key = `${rc.caller_id}\u0000${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: rc.caller_id,
        target,
        relation: "calls",
        confidence: "EXTRACTED",
      });
    }
  }

  return edges;
}

function resolveOne(
  rc: { callee_name: string; receiver?: string; caller_id: string },
  byLocal: Map<string, ImportBinding>,
  fromFile: string,
  knownFiles: Set<string>,
  exportIndex: Map<string, Map<string, string>>,
): string | null {
  // Pick the binding + the export name we're looking for in the target module.
  let binding: ImportBinding | undefined;
  let exportName: string;

  if (rc.receiver !== undefined) {
    // ns.foo() — receiver must be a namespace import; export name is the property.
    binding = byLocal.get(rc.receiver);
    if (binding === undefined || binding.kind !== "namespace") return null;
    // `import type * as ns` is type-only — ns.foo() is never a runtime call.
    if (binding.type_only) return null;
    exportName = rc.callee_name;
  } else {
    binding = byLocal.get(rc.callee_name);
    if (binding === undefined) return null;
    // A type-only import can never be a runtime value call target.
    if (binding.type_only) return null;
    // Only NAMED imports resolve. DEFAULT is skipped (we don't track which
    // export is `default`, so binding it to a file's lone NAMED export would
    // be a wrong edge); a namespace binding called as a value (ns()) is also
    // skipped. Both land in Phase 1.5b.
    if (binding.kind !== "named") return null;
    exportName = binding.imported_name;
  }

  const targetFile = resolveModule(fromFile, binding.specifier, knownFiles);
  if (targetFile === null) return null;

  return exportIndex.get(targetFile)?.get(exportName) ?? null;
}

const MODULE_SUFFIX = "::module";
const EXTERNAL_PREFIX = "external:";

/**
 * Repoint `imports` edges that currently target a placeholder
 * `external:<specifier>` at the REAL module node of the resolved file, when the
 * specifier is relative and resolves to a known repo file. Bare specifiers
 * (npm packages) and unresolvable relatives keep their `external:` target so
 * the distinction "our code vs a dependency" is preserved.
 *
 * Returns a NEW array; input is not mutated. The source of an import edge is a
 * module node id (`<file>::module`), from which we recover the importing file.
 */
export function repointImportEdges(
  links: readonly GraphEdge[],
  knownFiles: Set<string>,
): GraphEdge[] {
  return links.map((e) => {
    if (e.relation !== "imports" || !e.target.startsWith(EXTERNAL_PREFIX)) return e;
    if (!e.source.endsWith(MODULE_SUFFIX)) return e;
    const fromFile = e.source.slice(0, -MODULE_SUFFIX.length);
    const specifier = e.target.slice(EXTERNAL_PREFIX.length);
    const resolved = resolveModule(fromFile, specifier, knownFiles);
    if (resolved === null) return e; // bare or unresolvable — keep external:
    return { ...e, target: `${resolved}${MODULE_SUFFIX}` };
  });
}

const UNRESOLVED_PREFIX = "unresolved:";

/**
 * Repoint `extends`/`implements` edges whose target is a placeholder
 * `unresolved:<file>:<name>:<kind>` to the real base-type node:
 *   1. a declaration of `<name>` in the SAME file (intra-file heritage —
 *      previously left unresolved), else
 *   2. a NAMED-imported `<name>` resolved to its exporting file (cross-file).
 * Default/namespace/bare imports and unknown names keep the placeholder.
 *
 * Returns a NEW array; input is not mutated.
 */
export function resolveHeritageEdges(
  links: readonly GraphEdge[],
  extractions: readonly FileExtraction[],
  nodes: readonly GraphNode[],
): GraphEdge[] {
  const knownFiles = new Set<string>();
  for (const ex of extractions) knownFiles.add(ex.source_file);
  const exportIndex = buildExportIndex(nodes);

  // Per-file local index of extendable declarations (incl. non-exported), by name.
  const localIndex = new Map<string, Map<string, string>>();
  for (const n of nodes) {
    if (!HERITAGE_KINDS.has(n.kind)) continue;
    let m = localIndex.get(n.source_file);
    if (!m) { m = new Map(); localIndex.set(n.source_file, m); }
    if (!m.has(n.label)) m.set(n.label, n.id);
  }

  // Per-file import bindings, by local name.
  const bindingsByFile = new Map<string, Map<string, ImportBinding>>();
  for (const ex of extractions) {
    const m = new Map<string, ImportBinding>();
    for (const b of ex.import_bindings ?? []) if (!m.has(b.local_name)) m.set(b.local_name, b);
    bindingsByFile.set(ex.source_file, m);
  }

  return links.map((e) => {
    if (e.relation !== "extends" && e.relation !== "implements") return e;
    if (!e.target.startsWith(UNRESOLVED_PREFIX)) return e;
    const parsed = parseUnresolved(e.target);
    if (parsed === null) return e;
    const { file, name } = parsed;

    // 1. Same-file declaration.
    const local = localIndex.get(file)?.get(name);
    if (local !== undefined) return { ...e, target: local };

    // 2. Named import resolved to its exporting file.
    const binding = bindingsByFile.get(file)?.get(name);
    if (binding !== undefined && binding.kind === "named") {
      const targetFile = resolveModule(file, binding.specifier, knownFiles);
      if (targetFile !== null) {
        const id = exportIndex.get(targetFile)?.get(binding.imported_name);
        if (id !== undefined) return { ...e, target: id };
      }
    }
    return e; // keep the placeholder
  });
}

/** Parse `unresolved:<file>:<name>:<kind>` → {file, name}. file has no colons. */
function parseUnresolved(target: string): { file: string; name: string } | null {
  const body = target.slice(UNRESOLVED_PREFIX.length);
  const lastColon = body.lastIndexOf(":");          // before <kind>
  if (lastColon <= 0) return null;
  const rest = body.slice(0, lastColon);            // <file>:<name>
  const nameColon = rest.lastIndexOf(":");
  if (nameColon <= 0) return null;
  const file = rest.slice(0, nameColon);
  const name = rest.slice(nameColon + 1);
  if (file.length === 0 || name.length === 0) return null;
  return { file, name };
}

/**
 * Resolve a RELATIVE module specifier from `fromFile` to a known repo file.
 * Returns null for bare specifiers (node_modules / aliases) and when no
 * candidate matches a known source file. Tries the common TS resolution
 * suffixes in order.
 */
export function resolveModule(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  // Python files use package-relative / dotted-absolute imports, not `./`
  // path specifiers — route them through the Python resolver.
  if (isPythonFile(fromFile)) return resolvePythonModule(fromFile, specifier, knownFiles);

  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;

  const baseDir = posix.dirname(fromFile);
  // Pull off an explicit extension if the specifier carries one
  // (e.g. "./b.js" under NodeNext, or "./b.tsx"); the remainder is the stem.
  const explicit = specifier.match(/\.(tsx?|jsx?|mjs|cjs)$/)?.[0] ?? null;
  const stem = explicit ? specifier.slice(0, -explicit.length) : specifier;
  const joined = posix.normalize(posix.join(baseDir, stem));

  const TS_EXTS = [".ts", ".tsx"];
  const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];
  // Order candidates so the import RESOLVES to what it most likely means:
  //   1. the explicit extension the specifier named (if any),
  //   2. then the importer's own family (a .js importer prefers .js),
  //   3. then the other family.
  // This fixes a JS importer / explicit `.js` wrongly binding to a sibling
  // `.ts` when both exist (codex review). In the rare both-exist + ambiguous
  // case the choice is deterministic (honor what the specifier literally says,
  // else the importer's family).
  const importerIsJs = /\.(jsx?|mjs|cjs)$/.test(fromFile);
  const primary = importerIsJs ? JS_EXTS : TS_EXTS;
  const secondary = importerIsJs ? TS_EXTS : JS_EXTS;
  const exts = [
    ...(explicit ? [explicit] : []),
    ...primary,
    ...secondary,
  ].filter((e, i, a) => a.indexOf(e) === i); // dedup, keep first occurrence

  for (const e of exts) {
    const c = `${joined}${e}`;
    if (knownFiles.has(c)) return c;
  }
  for (const e of exts) {
    const c = `${joined}/index${e}`;
    if (knownFiles.has(c)) return c;
  }
  return null;
}

// ── Python module resolution ─────────────────────────────────────────────────

const PY_EXTS = [".py", ".pyi"];

/** True for Python source files (importer-side dispatch in resolveModule). */
function isPythonFile(p: string): boolean {
  return p.endsWith(".py") || p.endsWith(".pyi");
}

/**
 * Resolve a Python import specifier to a known repo file. Handles:
 *   - dot-relative: `.` (current package), `.mod`, `..pkg.mod` (climb levels),
 *   - dotted-absolute: `pkg.sub.mod` — anchored by UNIQUE path suffix against
 *     the known files (so we don't need to discover the source root).
 * High-confidence only: an ambiguous absolute suffix (multiple matches) is
 * DROPPED, not guessed — same doctrine as the TS resolver. Returns null for
 * stdlib / third-party modules (no matching repo file).
 */
export function resolvePythonModule(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  // Leading-dot count = relative-import level: "." => 1, ".." => 2, ".m" => 1.
  let dots = 0;
  while (dots < specifier.length && specifier[dots] === ".") dots++;
  const tail = specifier.slice(dots);
  const segs = tail.length > 0 ? tail.split(".") : [];

  if (dots === 0) {
    // Absolute dotted module — anchor by unique path suffix.
    if (segs.length === 0) return null;
    return matchPythonSuffix(segs.join("/"), knownFiles);
  }

  // Relative: start at the importer's package dir, climb (dots - 1) levels.
  let dir = posix.dirname(fromFile);
  let climbed = 1;
  for (; climbed < dots && dir !== "" && dir !== "."; climbed++) dir = posix.dirname(dir);
  // Over-climb: more leading dots than directories above the importer is an
  // invalid relative import. Drop it rather than clamp to "." and risk a
  // spurious match at the repo root (CodeRabbit).
  if (climbed < dots) return null;
  const base = segs.length > 0 ? posix.normalize(posix.join(dir, ...segs)) : dir;
  for (const e of PY_EXTS) if (knownFiles.has(`${base}${e}`)) return `${base}${e}`;
  for (const e of PY_EXTS) if (knownFiles.has(`${base}/__init__${e}`)) return `${base}/__init__${e}`;
  return null;
}

/**
 * Find the UNIQUE known file matching `<suffix>.py|.pyi` or
 * `<suffix>/__init__.py|.pyi` by path suffix. Exact (suffix is repo-root-anchored)
 * wins immediately; otherwise a single suffix match wins, multiple => null.
 */
function matchPythonSuffix(suffix: string, knownFiles: Set<string>): string | null {
  const targets = [
    ...PY_EXTS.map((e) => `${suffix}${e}`),
    ...PY_EXTS.map((e) => `${suffix}/__init__${e}`),
  ];
  for (const t of targets) {
    if (knownFiles.has(t)) return t;
    let hit: string | null = null;
    let count = 0;
    for (const f of knownFiles) {
      if (f.endsWith(`/${t}`)) { hit = f; count++; }
    }
    if (count === 1) return hit;
    // Ambiguity on ANY target form is sufficient grounds to drop the whole
    // resolution — don't fall through to the remaining forms (CodeRabbit).
    if (count > 1) return null;
  }
  return null;
}
