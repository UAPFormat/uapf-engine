// SessionManager: in-memory storage for active and completed sessions.
//
// v0.1 keeps sessions in-process. Durable persistence (required for
// production Orchestrated Process) is v0.2.
//
// AuditEmitter: structured logging of CloudEvents v1.0 records.
// v0.1 emits to console and buffers in the session record. v0.2 plugs in
// VeriDocs Register for signed durable storage.

import { v4 as uuidv4 } from "uuid";
import {
  SessionRecord,
  SessionState,
  AuditEvent,
  HostManifest,
  CapabilityRef,
} from "../types/uapf-ip";

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  create(args: {
    packageId: string;
    packageVersion?: string;
    processId: string;
    input: unknown;
    hostManifest: HostManifest;
    capabilityBindings: Record<string, CapabilityRef>;
    guardrails?: Record<string, unknown>;
  }): SessionRecord {
    const sessionId = `sess_${uuidv4().slice(0, 8)}`;
    const record: SessionRecord = {
      sessionId,
      packageId: args.packageId,
      packageVersion: args.packageVersion,
      processId: args.processId,
      hostManifest: args.hostManifest,
      capabilityBindings: args.capabilityBindings,
      guardrails: args.guardrails,
      state: "created",
      startedAt: new Date().toISOString(),
      input: args.input,
      auditChain: [],
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values());
  }

  setState(sessionId: string, state: SessionState): void {
    const s = this.sessions.get(sessionId);
    if (s) s.state = state;
  }

  complete(sessionId: string, output: unknown): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.state = "completed";
      s.completedAt = new Date().toISOString();
      s.output = output;
    }
  }

  fail(sessionId: string, errorMessage: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.state = "failed";
      s.completedAt = new Date().toISOString();
      s.errorMessage = errorMessage;
    }
  }

  // G2: abort a session before completion. Idempotent for already-finished
  // sessions — a completed/failed/aborted session is left untouched.
  abort(sessionId: string, reason?: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.state === "completed" || s.state === "failed" || s.state === "aborted") {
      return false;
    }
    s.state = "aborted";
    s.completedAt = new Date().toISOString();
    s.errorMessage = reason ? `aborted: ${reason}` : "aborted by host";
    return true;
  }

  appendAudit(sessionId: string, event: AuditEvent): void {
    const s = this.sessions.get(sessionId);
    if (s) s.auditChain.push(event);
  }
}

export class AuditEmitter {
  constructor(
    private readonly sessions: SessionManager,
    private readonly runtimeId: string = "uapf-engine"
  ) {}

  emit(args: {
    sessionId: string;
    packageId: string;
    packageVersion?: string;
    stepId?: string;
    type: string;
    data?: unknown;
    profile?: string;
    guardrailsHash?: string;   // G7: content hash of the active guardrails snapshot
  }): AuditEvent {
    const event: AuditEvent = {
      specversion: "1.0",
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      source: `dev.uapf.engine/${this.runtimeId}`,
      type: args.type,
      time: new Date().toISOString(),
      datacontenttype: "application/json",
      data: args.data,
      uapfsessionid: args.sessionId,
      uapfpackageid: args.packageId,
      uapfpackageversion: args.packageVersion,
      uapfstepid: args.stepId,
      uapfguardrailshash: args.guardrailsHash,
      uapfprofile: args.profile,
    };
    this.sessions.appendAudit(args.sessionId, event);
    // Structured log line — visible in container logs, friendly for jq.
    process.stdout.write(JSON.stringify({ audit: event }) + "\n");
    return event;
  }
}
