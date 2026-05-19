// SessionManager: storage for active and completed sessions.
//
// Sessions are held in memory and, when a sessions directory is configured
// (UAPF_SESSIONS_DIR, or ./data/sessions by default), mirrored to disk as
// <sessionId>.json and reloaded on startup — so sessions survive a restart.
// If the directory is not writable the manager degrades to in-memory only.
//
// AuditEmitter: structured logging of CloudEvents v1.0 records.
// Emits to console and buffers in the (now durable) session record.

import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import {
  SessionRecord,
  SessionState,
  AuditEvent,
  HostManifest,
  CapabilityRef,
} from "../types/uapf-ip";

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private persistenceDir?: string;

  // When a sessions directory is configured and writable, every session is
  // mirrored to <dir>/<sessionId>.json and reloaded on startup, so in-flight
  // and completed sessions survive a process restart. If the directory cannot
  // be created the manager degrades cleanly to pure in-memory operation.
  constructor(opts: { persistenceDir?: string } = {}) {
    const dir =
      opts.persistenceDir ??
      process.env.UAPF_SESSIONS_DIR ??
      path.join(process.cwd(), "data", "sessions");
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.persistenceDir = dir;
      this.loadAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        JSON.stringify({
          sessionPersistence: { disabled: true, dir, reason: msg },
        }) + "\n"
      );
      this.persistenceDir = undefined;
    }
  }

  /** Whether durable persistence is active. */
  isDurable(): boolean {
    return !!this.persistenceDir;
  }

  private loadAll(): void {
    if (!this.persistenceDir) return;
    let files: string[];
    try {
      files = fs
        .readdirSync(this.persistenceDir)
        .filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(this.persistenceDir, f), "utf-8");
        const rec = JSON.parse(raw) as SessionRecord;
        if (rec && rec.sessionId) this.sessions.set(rec.sessionId, rec);
      } catch {
        // skip a corrupt session file rather than failing startup
      }
    }
  }

  private persist(sessionId: string): void {
    if (!this.persistenceDir) return;
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    try {
      fs.writeFileSync(
        path.join(this.persistenceDir, `${sessionId}.json`),
        JSON.stringify(rec)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        JSON.stringify({ sessionPersistenceError: { sessionId, error: msg } }) +
          "\n"
      );
    }
  }

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
    this.persist(sessionId);
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
    if (s) {
      s.state = state;
      this.persist(sessionId);
    }
  }

  complete(sessionId: string, output: unknown): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.state = "completed";
      s.completedAt = new Date().toISOString();
      s.output = output;
      this.persist(sessionId);
    }
  }

  fail(sessionId: string, errorMessage: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.state = "failed";
      s.completedAt = new Date().toISOString();
      s.errorMessage = errorMessage;
      this.persist(sessionId);
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
    this.persist(sessionId);
    return true;
  }

  appendAudit(sessionId: string, event: AuditEvent): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.auditChain.push(event);
      this.persist(sessionId);
    }
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
    // G3: deliver the event to the host's /uapf/host/audit endpoint.
    // Fire-and-forget — audit delivery MUST NOT block process execution.
    this.deliverToHost(args.sessionId, event);
    return event;
  }

  // G3: POST a CloudEvent to the session host's audit endpoint.
  // Per the UAPF-IP REST binding, default audit delivery is
  // POST {hostBaseUrl}/uapf/host/audit. Hosts that prefer webhook/queue/polled
  // delivery are a v0.2 concern; v0.1 uses the default POST.
  private deliverToHost(sessionId: string, event: AuditEvent): void {
    const session = this.sessions.get(sessionId);
    const hostBaseUrl = session?.hostManifest?.hostBaseUrl;
    if (!hostBaseUrl) return; // no host (e.g. legacy stateless call) — skip
    const url = `${hostBaseUrl.replace(/\/$/, "")}/uapf/host/audit`;
    // Surface the documentId from the session input into the delivered event\'s
    // data so the host can correlate / stream audit events against the right
    // business object in real time. The in-memory audit + stdout log keep the
    // raw event unchanged.
    const sessInput = (session as unknown as { input?: Record<string, unknown> } | undefined)?.input;
    const docId = sessInput?.documentId;
    const correlationId = sessInput?.correlationId;
    const extra: Record<string, unknown> = {};
    if (docId != null) extra.documentId = docId;
    if (correlationId != null) extra.correlationId = correlationId;
    const payload =
      Object.keys(extra).length > 0
        ? { ...event, data: { ...((event.data as Record<string, unknown>) ?? {}), ...extra } }
        : event;
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/cloudevents+json" },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        JSON.stringify({
          auditDeliveryError: { sessionId, eventId: event.id, url, error: msg },
        }) + "\n"
      );
    });
  }
}
