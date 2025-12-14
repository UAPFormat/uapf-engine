# uapf-engine

Reference Node.js + TypeScript service that exposes a minimal HTTP API for loading and executing UAPF packages.

## Features

- Loads `.uapf` packages from a configurable directory (default: `./packages`).
- Supports workspace registry mode with a workspace index file and fallback scanning.
- Handles `.uapf` JSON stubs and `.uapf` ZIP containers (manifest + BPMN/DMN/CMMN/docs/tests assets).
- Validates packages via SSOT schemas when provided (best-effort when schemas are absent).
- Exposes endpoints to list packages, fetch artifacts, resolve resources, validate packages, execute a process once, and evaluate a decision.
- Designed to run on `localhost:4000` behind Apache/WAMP reverse proxy.

## Project structure

```
uapf-engine/
  src/
    config/          # Environment configuration
    engine/          # Execution engine interfaces and demo implementation
    http/            # Express routes and server bootstrap
    registry/        # Package registry for UAPF artifacts
    types/           # Shared TypeScript types
    utils/           # Logging utilities
  vendor/uapf-typescript/ # Local stub for the UAPF SDK
  test/             # Placeholder for future tests
```

## Getting started

### Prerequisites
- Node.js 20+
- npm

### Install dependencies

```bash
npm install
```

### Configuration

Environment variables (via `.env` or shell):

- `PORT` – HTTP port (default: `4000`).
- `UAPF_MODE` – registry mode: `packages`, `workspace`, or `auto` (default: `packages`).
- `PACKAGES_DIR` – directory containing `.uapf` packages (default: `./packages`).
- `WORKSPACE_DIR` – workspace root when `UAPF_MODE=workspace`/`auto` (required in workspace mode).
- `WORKSPACE_INDEX_FILENAMES` – comma-separated list of workspace index candidates (default: `workspace.json,uapf.workspace.json,uapf-workspace.json`).
- `UAPF_SCHEMAS_DIR` – optional path to SSOT schemas for validation.
- `ARTIFACT_CACHE_DIR` – cache directory for extracted ZIP artifacts (default: `./.cache/uapf-artifacts`).

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Start (from compiled output)

```bash
npm start
```

## HTTP API

`GET /health` – health check.
`GET /_/meta` – service metadata (`service`, `mode`, `version`).
`GET /uapf/packages` – list loaded packages with processes and decisions.
`GET /uapf/packages/:packageId` – package summary and source metadata.
`GET /uapf/packages/:packageId/artifacts/:kind?id=...` – download manifest/BPMN/DMN/CMMN/docs/tests artifacts.
`POST /uapf/execute-process` – body: `{ packageId, processId, input }` (returns mode, artifact refs, and stubbed outputs).
`POST /uapf/evaluate-decision` – body: `{ packageId, decisionId, input }` (returns mode, artifact refs, and stubbed outputs).
`POST /uapf/resolve-resources` – body: `{ packageId, processId?, taskId? }` to retrieve resource bindings.
`POST /uapf/validate` – body: `{ packageId? }` to validate a package or the entire registry/workspace.

Responses are stubbed for now and echo the provided inputs along with contextual metadata.

## Notes on the UAPF SDK stub

The repository bundles a minimal `@uapf/uapf-typescript` stub under `vendor/uapf-typescript` so the project works without the published SDK. The stub reads `.uapf` files as JSON documents containing a `manifest` object. Replace this dependency with the official SDK when available.
