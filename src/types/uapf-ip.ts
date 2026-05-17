// UAPF-IP types — session lifecycle, capability bindings, audit events.
// See https://github.com/UAPFormat/UAPF-IP for the normative spec.

export interface CapabilityRef {
  namespace: string;       // e.g. "task", "ai", "data"
  operation: string;       // e.g. "assign", "classify", "read"
  version: number;         // e.g. 1
}

export function parseCapabilityRef(ref: string): CapabilityRef {
  // accepts "task.assign@1" or "task.assign@1+"
  const m = ref.match(/^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@(\d+)\+?$/);
  if (!m) throw new Error(`Invalid capability reference: ${ref}`);
  return { namespace: m[1], operation: m[2], version: parseInt(m[3], 10) };
}

export function formatCapabilityRef(c: CapabilityRef): string {
  return `${c.namespace}.${c.operation}@${c.version}`;
}

export interface HostCapability extends CapabilityRef {
  // Optional: free-form metadata the host wants to advertise about this capability
  meta?: Record<string, unknown>;
}

export interface HostManifest {
  hostDid: string;
  hostBaseUrl: string;          // where the runtime posts capability calls
  profiles: string[];           // e.g. ["uapf-ip-orchestrated"]
  capabilities: HostCapability[];
  manifestSignature?: string;   // VC over the manifest (v0.1: optional)
}

export type SessionState =
  | "created"
  | "active"
  | "suspended"
  | "completed"
  | "aborted"
  | "failed";

export interface SessionRecord {
  sessionId: string;
  packageId: string;
  packageVersion?: string;
  processId: string;
  hostManifest: HostManifest;
  capabilityBindings: Record<string, CapabilityRef>; // package-need -> host-capability
  guardrails?: Record<string, unknown>;
  state: SessionState;
  startedAt: string;
  completedAt?: string;
  input: unknown;
  output?: unknown;
  errorMessage?: string;
  auditChain: AuditEvent[];
}

export interface StartSessionRequest {
  packageId: string;
  packageVersion?: string;
  processId: string;
  input: unknown;
  hostManifest: HostManifest;
  guardrailsRef?: string;
}

export interface StartSessionResponse {
  sessionId: string;
  state: SessionState;
  auditChainRoot?: string;
  output?: unknown;          // present if process completed synchronously
}

// CloudEvents v1.0 envelope with UAPF-IP extension attributes
export interface AuditEvent {
  // CloudEvents core
  specversion: "1.0";
  id: string;
  source: string;
  type: string;              // e.g. "dev.uapf.session.created", "dev.uapf.capability.invoked"
  time: string;
  datacontenttype?: string;
  subject?: string;
  data?: unknown;
  // UAPF-IP extensions
  uapfsessionid: string;
  uapfpackageid: string;
  uapfpackageversion?: string;
  uapfstepid?: string;
  uapfsignature?: string;
  uapfguardrailshash?: string;
  uapfprofile?: string;
}

export interface CapabilityInvocation {
  sessionId: string;
  stepId: string;
  capability: CapabilityRef;
  input: unknown;
  guardrails?: Record<string, unknown>;
  schemaRef?: string;   // uapf:schemaRef of the invoking BPMN task (I/O contract)
}

export interface CapabilityResult {
  output: unknown;
  auditEvent?: AuditEvent;
}
