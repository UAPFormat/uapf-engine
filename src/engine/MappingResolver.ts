// MappingResolver — resolves a BPMN task to its executor from the package's
// resources/mappings.yaml (kind: uapf.resources.mapping).
//
//   targets:
//     - id: system.opendms-document-api
//       type: system_api
//       capabilities: [capability.document.fetch, capability.data.write]
//   bindings:
//     - source: { type: bpmn.serviceTask, ref: RegisterDocument }
//       targetId: system.opendms-document-api
//       capability: capability.document.fetch   # needed when the target has several
//       schemaRef: ...                           # optional output contract for the host
//       mode: autonomous
//
// A BPMN attribute (uapf:capability) still wins over the mapping, so older
// packages keep working unchanged.

export interface MappingTarget {
  id: string;
  type?: string;
  name?: string;
  capabilities?: string[];
}

export interface ResolvedBinding {
  taskId: string;
  targetId: string;
  targetType?: string;
  targetName?: string;
  mode?: string;
  /** Capability reference in engine form, e.g. "document.fetch@1". */
  capability?: string;
  /** Output contract the host should apply (same role as uapf:schemaRef). */
  schemaRef?: string;
}

/** "capability.document.fetch" | "document.fetch" | "document.fetch@1+" -> "document.fetch@1" */
export function toEngineCapability(raw: string): string {
  let s = String(raw).trim();
  if (s.startsWith("capability.")) s = s.slice("capability.".length);
  s = s.replace(/\+$/, "");
  if (!/@\d+$/.test(s)) s = `${s}@1`;
  return s;
}

export function resolveBinding(
  mappings: unknown,
  taskId: string
): ResolvedBinding | undefined {
  if (!mappings || typeof mappings !== "object") return undefined;
  const m = mappings as Record<string, unknown>;
  const bindings = Array.isArray(m.bindings) ? (m.bindings as any[]) : [];
  const targets = Array.isArray(m.targets) ? (m.targets as MappingTarget[]) : [];

  const b = bindings.find((x) => x?.source?.ref === taskId);
  if (!b) return undefined;
  const target = targets.find((t) => t?.id === b.targetId);

  const out: ResolvedBinding = {
    taskId,
    targetId: b.targetId,
    targetType: target?.type,
    targetName: target?.name,
    mode: b.mode,
    schemaRef: typeof b.schemaRef === "string" ? b.schemaRef : undefined,
  };

  const caps = (target?.capabilities ?? []).map(toEngineCapability);
  if (b.capability) {
    const wanted = toEngineCapability(b.capability);
    if (caps.length > 0 && !caps.includes(wanted)) {
      throw new Error(
        `mappings: binding for ${taskId} names ${wanted}, which target ${b.targetId} does not offer (${caps.join(", ")})`
      );
    }
    out.capability = wanted;
  } else if (caps.length === 1) {
    out.capability = caps[0];
  } else if (caps.length > 1) {
    throw new Error(
      `mappings: target ${b.targetId} offers several capabilities (${caps.join(", ")}); ` +
        `add "capability:" to the binding for ${taskId}`
    );
  }
  return out;
}
