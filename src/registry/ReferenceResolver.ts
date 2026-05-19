// ReferenceResolver — resolves cross-package references for the UAPF
// L0-L4 package model.
//
// UAPF packages form a reference hierarchy: an L0 workspace/enterprise
// index references L1 packages, L1 references L2, and so on down to L4
// atomic executable packages. Higher levels REFERENCE lower levels — they
// never copy them. The manifest `level` number increases as you descend
// (L0=0 ... L4=4), so a referring package's level must not exceed the
// level of any package it references.
//
// A package declares its references in the manifest `references` field
// (alias: `referencedPackages`). Each entry is either:
//   - a string:  "package://<id>@<version>", "<id>@<version>" or "<id>"
//   - an object: { packageId | id, version? }
//
// This resolver is pure (no I/O). It is given a lookup function over the
// already-loaded packages and walks the reference graph, reporting missing
// references, level-ordering violations and cycles.

export interface RefNodeInfo {
  packageId: string;
  level?: number;
  references: string[]; // normalised "<id>" or "<id>@<version>" strings
}

export interface ResolvedReference {
  packageId: string;
  version?: string;
  level?: number;
  resolved: boolean;
  children: ResolvedReference[];
}

export interface ReferenceDiagnostic {
  level: "error" | "warn";
  message: string;
  packageId?: string;
}

export interface ReferenceResolutionResult {
  root: string;
  tree: ResolvedReference;
  diagnostics: ReferenceDiagnostic[];
  ok: boolean;
  resolvedPackageIds: string[];
}

export interface ParsedRef {
  packageId: string;
  version?: string;
}

/** Parse one raw reference (string or object) into { packageId, version }. */
export function parsePackageRef(raw: unknown): ParsedRef | null {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const id = (o.packageId ?? o.id) as string | undefined;
    if (!id) return null;
    const version = o.version as string | undefined;
    return version ? { packageId: id, version } : { packageId: id };
  }
  let s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("package://")) s = s.slice("package://".length);
  s = s.split("/")[0]; // drop any path after the id@version segment
  const at = s.indexOf("@");
  if (at >= 0) {
    const version = s.slice(at + 1);
    return version
      ? { packageId: s.slice(0, at), version }
      : { packageId: s.slice(0, at) };
  }
  return { packageId: s };
}

/** Extract the declared package references from a manifest object. */
export function extractReferences(manifest: unknown): ParsedRef[] {
  if (!manifest || typeof manifest !== "object") return [];
  const m = manifest as Record<string, unknown>;
  const raw = m.references ?? m.referencedPackages;
  if (!Array.isArray(raw)) return [];
  const out: ParsedRef[] = [];
  for (const entry of raw) {
    const parsed = parsePackageRef(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

export class ReferenceResolver {
  constructor(
    private readonly lookup: (packageId: string) => RefNodeInfo | undefined
  ) {}

  resolve(rootPackageId: string): ReferenceResolutionResult {
    const diagnostics: ReferenceDiagnostic[] = [];
    const resolvedIds = new Set<string>();
    const memo = new Map<string, ResolvedReference>();

    const visit = (
      packageId: string,
      version: string | undefined,
      ancestry: string[]
    ): ResolvedReference => {
      // Cycle detection on the active path.
      if (ancestry.includes(packageId)) {
        diagnostics.push({
          level: "error",
          message: `reference cycle detected: ${[...ancestry, packageId].join(" -> ")}`,
          packageId,
        });
        return { packageId, version, resolved: true, children: [] };
      }

      const cached = memo.get(packageId);
      if (cached) return cached;

      const info = this.lookup(packageId);
      if (!info) {
        diagnostics.push({
          level: "error",
          message: `referenced package not found in registry: ${packageId}`,
          packageId,
        });
        return { packageId, version, resolved: false, children: [] };
      }

      resolvedIds.add(packageId);
      const node: ResolvedReference = {
        packageId,
        version,
        level: info.level,
        resolved: true,
        children: [],
      };
      memo.set(packageId, node);

      const childAncestry = [...ancestry, packageId];
      for (const ref of info.references) {
        const parsed = parsePackageRef(ref);
        if (!parsed) continue;
        const child = visit(parsed.packageId, parsed.version, childAncestry);

        // Level-ordering check: a referenced package must sit at the same
        // or a lower hierarchy level (a >= level number). Referencing UP
        // the hierarchy is an error; a same-level reference is unusual and
        // is surfaced as a warning.
        if (
          child.resolved &&
          typeof info.level === "number" &&
          typeof child.level === "number"
        ) {
          if (child.level < info.level) {
            diagnostics.push({
              level: "error",
              message:
                `package ${packageId} (L${info.level}) references ` +
                `${child.packageId} (L${child.level}) — references must point ` +
                `down the L0-L4 hierarchy, not up`,
              packageId: child.packageId,
            });
          } else if (child.level === info.level) {
            diagnostics.push({
              level: "warn",
              message:
                `package ${packageId} references ${child.packageId} at the ` +
                `same level (L${info.level})`,
              packageId: child.packageId,
            });
          }
        }
        node.children.push(child);
      }
      return node;
    };

    const tree = visit(rootPackageId, undefined, []);

    // De-duplicate diagnostics (a shared package reached via multiple paths
    // would otherwise report the same finding more than once).
    const seen = new Set<string>();
    const deduped = diagnostics.filter((d) => {
      const key = `${d.level}|${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      root: rootPackageId,
      tree,
      diagnostics: deduped,
      ok: deduped.every((d) => d.level !== "error"),
      resolvedPackageIds: Array.from(resolvedIds),
    };
  }
}
