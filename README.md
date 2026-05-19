# uapf-engine

Reference execution engine for UAPF packages. Implements the v0.1 [UAPF Integration Protocol](https://github.com/UAPFormat/UAPF-IP) REST binding plus a backwards-compatible stateless surface.

## What's in here

- Real BPMN process execution: linear sequences, service tasks, business rule tasks, user tasks, and exclusive + parallel gateways. Custom token-based walker; pluggable engine interface lets you swap in bpmn-engine or Camunda Zeebe later.
- Real DMN decision-table evaluation with UNIQUE / FIRST / PRIORITY / ANY / COLLECT hit policies (COLLECT with SUM / MIN / MAX / COUNT aggregation) and comparison operators / FEEL intervals in input entries.
- User tasks dispatched to a host `task.*` capability — the host owns the human-interaction lifecycle and returns the decision.
- Minimal CMMN 1.1 case execution: stages, tasks, milestones, and entry-criterion sentries (planItemOnPart triggers + ifPart conditions). See `CmmnEngine` for the covered subset.
- L0–L4 cross-package reference resolution: resolves and validates the package reference graph (level ordering, missing references, cycles) via `IUapfRegistry.resolveReferences`.
- Session lifecycle (create, active, completed, failed, aborted) with durable, disk-backed persistence — sessions survive a restart; degrades to in-memory if no writable directory.
- Capability matchmaking: validates host manifest against package needs at session start; fails fast if anything is missing.
- CloudEvents v1.0 audit emission with UAPF-IP extensions; events buffered per session and logged as structured JSON.
- HTTP callback dispatcher (HostClient) that calls back into hosts via `POST /uapf/host/capability/{namespace}/{operation}`.

## What this is not yet

- CMMN execution covers a documented subset — no full plan-item lifecycle, exit criteria, repetition rules, event listeners or planning tables; and it is not yet wired to a case-session HTTP surface.
- No DID-VC signing on requests yet — token-based auth placeholder. v0.2.
- Custom minimal BPMN walker, not full bpmn-engine. Production deployments can swap in via the `IExecutionEngine` interface.

## HTTP API

### v0.1 UAPF-IP session surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/uapf/start-session` | Start a process execution against a host manifest |
| `GET` | `/uapf/sessions` | List sessions |
| `GET` | `/uapf/sessions/:id` | Inspect a session |
| `GET` | `/uapf/sessions/:id/audit` | Get the audit chain for a session |

### Legacy stateless surface (back-compat)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/uapf/execute-process` | Legacy one-shot process execution (now returns "use start-session") |
| `POST` | `/uapf/evaluate-decision` | Stateless DMN evaluation |
| `POST` | `/uapf/resolve-resources` | Resource resolution |
| `POST` | `/uapf/validate` | Package validation |

### Registry

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/uapf/packages` | List loaded packages |
| `GET` | `/uapf/packages/:id` | Package summary |
| `GET` | `/uapf/packages/:id/artifacts/:kind` | Fetch a specific artifact (bpmn, dmn, manifest, etc.) |

## Starting a session

```json
POST /uapf/start-session
{
  "packageId": "com.example.sre.incident-response",
  "processId": "incident-response",
  "input": { "severity": "critical", "service": "checkout-api" },
  "hostManifest": {
    "hostDid": "did:web:host.example.com",
    "hostBaseUrl": "http://host.example.com",
    "profiles": ["uapf-ip-orchestrated"],
    "capabilities": [
      { "namespace": "data", "operation": "read", "version": 1 },
      { "namespace": "ai", "operation": "classify", "version": 1 },
      { "namespace": "task", "operation": "assign", "version": 1 },
      { "namespace": "event", "operation": "emit", "version": 1 }
    ]
  }
}
```

The engine fetches the package's required capabilities, matches them against the host manifest, fails fast if any are missing, then walks the BPMN. Each service task triggers a `POST` to `hostBaseUrl/uapf/host/capability/{namespace}/{operation}` with the current variables and an audit-event reference. Each business rule task evaluates the named DMN decision in-process. Audit events stream as stdout JSON lines and accumulate on the session record.

## Getting started

```bash
npm install
npm run build
npm start
```

Or for development:

```bash
npm run dev
```

The engine listens on `localhost:4000` by default. Set `PORT`, `UAPF_MODE`, `PACKAGES_DIR`, `WORKSPACE_DIR` and `UAPF_SESSIONS_DIR` per the documented config.

Run the test suite (builds, then runs the functional checks):

```bash
npm test
```

## Project layout

```
uapf-engine/
├── src/
│   ├── config/           Environment configuration
│   ├── engine/
│   │   ├── ExecutionEngine.ts        Legacy interface
│   │   ├── SimpleExecutionEngine.ts  Legacy stub
│   │   ├── RealExecutionEngine.ts    v0.1 real implementation
│   │   ├── BpmnWalker.ts             Token-based BPMN walker (gateways)
│   │   ├── ConditionEvaluator.ts     BPMN/CMMN condition evaluation
│   │   ├── DmnTableEvaluator.ts      DMN decision-table evaluator
│   │   ├── CmmnEngine.ts             Minimal CMMN 1.1 case executor
│   │   ├── HostClient.ts             HTTP callback client
│   │   └── SessionManager.ts         Durable sessions + audit emitter
│   ├── http/
│   │   ├── server.ts                 Express bootstrap
│   │   └── routes.ts                 Endpoints
│   ├── registry/                     Package loading, validation,
│   │                                 L0–L4 reference resolution
│   ├── types/
│   │   ├── uapf.ts                   Package types
│   │   └── uapf-ip.ts                Session, capability, audit types
│   └── utils/
├── test/                             Functional test suites
└── public/                           Dashboard HTML
```

## License

MIT.
