# Changelog

## [1.2.0] - 2026-05-20

### Added — UAPF v2.4.0 Algorithm Cards support
- New `algorithm-card` artifact kind. Packages may now ship cards under
  `algorithms/*.card.{yaml,yml,json}`. The loader discovers them and
  parses them into the package's `algorithmCards` map keyed by card id.
- BPMN walker reads the v2.4.0 `uapf:algorithmCardRef` attribute on
  service / business-rule / abstract tasks. The XML parser strips
  namespace prefixes (`removeNSPrefix: true`) so any prefix works
  — `uapf:`, `uapf24:`, `uapfa:`, etc — as long as the namespace URI is
  the v2.4.0 one or the attribute is bound under any prefix to the
  same local name.
- `RealExecutionEngine` enriches `dev.uapf.capability.invoking` and
  `dev.uapf.capability.invoked` audit events with an `algorithmCard`
  payload containing `id`, `version`, `algorithm_kind`, `determinism`,
  and `risk`. If a `uapf:algorithmCardRef` is present on the task but
  no matching card is loaded, the event carries `{ id, resolved: false }`
  instead of dropping the reference silently.
- `UapfValidator` validates each loaded card against
  `algorithm-card.schema.json` (looked up under `UAPF_SCHEMAS_DIR`).
- New SEM-012 referential-integrity check: every BPMN task with
  `uapf:algorithmCardRef` MUST resolve to a card in the same package's
  `algorithms/` folder. Unresolved refs are reported as ERROR.
- New HTTP endpoints:
  - `GET /uapf/packages/:packageId/algorithms` — list compact summaries
    of all cards in a package.
  - `GET /uapf/packages/:packageId/algorithms/:cardId` — get a single
    card's full body as JSON.
  - The existing `GET /uapf/packages/:packageId/artifacts/:kind`
    endpoint now accepts `kind=algorithm-card`.
- `PackageSummary` carries `algorithmCards` so the workspace registry
  exposes them through the standard summary path consumers already use.

### Changed
- `package.json` version 1.1.0 → 1.2.0.

### Compatibility
- Packages that do not carry algorithm cards are unaffected. Pre-v2.4.0
  packages continue to work; the BPMN walker simply observes that
  `algorithmCardRef` is undefined on their tasks and the audit events
  carry no `algorithmCard` field.

