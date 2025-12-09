# uapf-engine

Reference Node.js + TypeScript service that exposes a minimal HTTP API for loading and executing UAPF packages.

## Features

- Loads `.uapf` packages from a configurable directory (default: `./packages`).
- Validates packages via `@uapf/uapf-typescript` (stubbed locally for now).
- Exposes endpoints to list packages, execute a process once, and evaluate a decision.
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
- `PACKAGES_DIR` – directory containing `.uapf` packages (default: `./packages`).

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

- `GET /health` – health check.
- `GET /uapf/packages` – list loaded packages with processes and decisions.
- `POST /uapf/execute-process` – body: `{ packageId, processId, input }`.
- `POST /uapf/evaluate-decision` – body: `{ packageId, decisionId, input }`.

Responses are stubbed for now and echo the provided inputs along with contextual metadata.

## Notes on the UAPF SDK stub

The repository bundles a minimal `@uapf/uapf-typescript` stub under `vendor/uapf-typescript` so the project works without the published SDK. The stub reads `.uapf` files as JSON documents containing a `manifest` object. Replace this dependency with the official SDK when available.
