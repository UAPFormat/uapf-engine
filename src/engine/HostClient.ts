// HostClient: calls back into a host to invoke its capabilities.
//
// Per the UAPF-IP REST binding, the runtime calls:
//   POST {hostBaseUrl}/uapf/host/capability/{namespace}/{operation}
//
// For v0.1 we use simple token-based auth (Bearer header). DID-VC signing
// is deferred to v0.2 when we wire the identity layer in.

import fetch from "node-fetch";
import { CapabilityRef, CapabilityInvocation, CapabilityResult } from "../types/uapf-ip";

export interface HostClientOptions {
  hostBaseUrl: string;
  authToken?: string;          // Bearer token for now; replace with VC in v0.2
  timeoutMs?: number;
}

export class HostClient {
  constructor(private readonly opts: HostClientOptions) {}

  async invoke(invocation: CapabilityInvocation): Promise<CapabilityResult> {
    const { namespace, operation } = invocation.capability;
    const url = `${this.opts.hostBaseUrl.replace(/\/$/, "")}/uapf/host/capability/${namespace}/${operation}`;
    const body = {
      sessionId: invocation.sessionId,
      stepId: invocation.stepId,
      input: invocation.input,
      guardrails: invocation.guardrails,
      schemaRef: invocation.schemaRef,
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    if (this.opts.authToken) {
      headers["Authorization"] = `Bearer ${this.opts.authToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { rawText: text };
      }
      if (!res.ok) {
        throw new Error(
          `Host capability invocation failed (${res.status}): ${formatCapabilityRef(invocation.capability)} -> ${text.slice(0, 200)}`
        );
      }
      const obj = parsed as Record<string, unknown>;
      return {
        output: obj.output ?? obj,
        auditEvent: (obj.auditEvent as never) || undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchManifest(): Promise<unknown> {
    const url = `${this.opts.hostBaseUrl.replace(/\/$/, "")}/uapf/host/manifest`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.opts.authToken) {
      headers["Authorization"] = `Bearer ${this.opts.authToken}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch host manifest (${res.status})`);
    }
    return res.json();
  }
}

function formatCapabilityRef(c: CapabilityRef): string {
  return `${c.namespace}.${c.operation}@${c.version}`;
}
