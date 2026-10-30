# Finny Pi harness implementation status

Last updated: 2026-10-30

This records what is present in the QM source tree. It is implementation evidence, not a claim that Finny is production-ready.

## Implemented

- The Finny profile uses QM's Pi harness and exposes only the native `finance` tool.
- The model-visible finance input is one object: `{ "request": "<complete finance request>" }`.
- The host owns Finance IR normalization, capability/schema compilation, Golden Loop transitions, approval, source custody, artifact policy, verification, and release.
- Reviewed finance knowledge is loaded from the content-addressed `finny-skills` bundle with ranked section retrieval, provenance, and no silent default truncation.
- NetSuite credentials are read through QM service-credential custody; values are not placed in prompts, traces, or durable summaries. Hindsight is advisory.
- Finny requires Postgres-backed sessions and runs plus a stable `CONNECTOR_SECRET_KEY`. Credentials, safe diagnostics, full Golden Loop checkpoints, and private query/source evidence survive process restarts.
- Stable workflow event IDs, a shared per-run advisory lock, and deterministic artifact identities prevent overlapping workers from duplicating stage work; a resumed run starts at its first incomplete stage.
- Typed failures distinguish unsupported capability, missing schema mapping, credential/configuration faults, provider faults, verification failure, and policy blocks.
- Provider HTTP and transport failures retain allowlisted cause, retryability, dependency, and status metadata in durable diagnostics without copying upstream bodies or credential material.
- Finny startup requires an operator-selected positive `FINNY_PROVIDER_TIMEOUT_MS`; every live provider request receives a fresh deadline so a stalled dependency cannot hold the durable run lock indefinitely.
- Finny-created artifact bytes use namespaced durable custody.
- Slack acknowledgements retain provider receipts that bind exact rendered content and uploaded file digests to delivery attestation, including reconstruction from the posted Slack thread after a process restart loses the original acknowledgement.
- Safe trace v2, `/v1/finny/health`, and bounded offline autoresearch scaffolding are implemented.

## Configuration contract

Finny is opt-in. `FINNY_PROFILE=finny` selects the profile and requires `HARNESS=pi` or the default Pi harness. `PI_MODEL` is the single model setting for both the Finny profile and Pi; it must be set to the pinned deployment model. There is no Finny-specific model override or precedence rule.

`FINNY_PROVIDER_TIMEOUT_MS` is required and must be a positive integer. It applies independently to each Hindsight bank recall and each NetSuite page request. `FINNY_SKILLS_DIR` is optional; when present, it is resolved to an absolute path and supplies the reviewed Finny knowledge bundle.

The profile accepts only durable runtime combinations: `DATABASE_URL` must be present, `SESSION_STORE` and `RUN_STORE` must both resolve to `postgres`, and `CONNECTOR_SECRET_KEY` must be stable across process replacements. `FINNY_SKILLS_DIR` and `FINNY_PROVIDER_TIMEOUT_MS` are rejected unless the Finny profile is selected. With `FINNY_PROFILE` unset, the existing Pi configuration remains unchanged and `PI_MODEL` retains its normal meaning.

Key source links:

- [`src/finny/native-finance-tool.ts`](../src/finny/native-finance-tool.ts) — one-call host orchestration and approval resume.
- [`src/finny/finance-ir.ts`](../src/finny/finance-ir.ts) — typed intent normalization.
- [`src/finny/capability-registry.ts`](../src/finny/capability-registry.ts) — reviewed capability/schema authority.
- [`src/finny/golden-loop.ts`](../src/finny/golden-loop.ts) — host-owned ledger/reducer.
- [`src/finny/run-store.ts`](../src/finny/run-store.ts) — durable stage checkpoints and per-run serialization.
- [`src/finny/pi-profile.ts`](../src/finny/pi-profile.ts) — Pi restriction, knowledge injection, and release suppression.
- [`src/finny/credential-brokered-finance-service.ts`](../src/finny/credential-brokered-finance-service.ts) — opaque credential boundary.
- [`src/finny/evidence-backed-finance-service.ts`](../src/finny/evidence-backed-finance-service.ts) — evidence custody, artifacts, repeat pull, and accounting verification.
- [`src/finny/knowledge-index.ts`](../src/finny/knowledge-index.ts) — reviewed knowledge index.
- [`src/finny/autoresearch.ts`](../src/finny/autoresearch.ts) — bounded offline candidate evaluation.
- [`test/finny-finance-run.test.ts`](../test/finny-finance-run.test.ts) and [`test/finny-web-path.test.ts`](../test/finny-web-path.test.ts) — host-run and real QM/Pi web-path coverage.

## Verified boundary

An independent verification gate passed the focused architecture: one model-visible call, reviewed-query compilation, exact approval binding, stable workflow identity across resume, changed-request rejection, typed terminal failures, and safe trace exposure.

The executable registry currently contains exactly one capability: current, all-entity, source-base-currency, aggregate NetSuite AP control balance. That narrow registry is why broad finance prompts still fail closed.

## Not production-ready

- Open AR by entity and historical cutoff is not compiled.
- Receipts, aging, synthetic legacy-ERP migrated invoices, detailed grain, entity/book/currency selection, and most other skill-described tasks are not compiled.
- Live provider acceptance requires deployment-owned NetSuite credentials and optional advisory-provider credentials bound through QM; this source change includes no such bindings.
- A process crash after NetSuite completed a read but before the source checkpoint can repeat that read. The read is side-effect-free; completed checkpoints resume without repeating provider work, and overlapping live workers are serialized before provider work.
- Slack ingress and delivery attestation are implemented, but live Firefox/Slack parity evidence is not available in the current development environment.
- The safe trace is not yet the complete queue/model/provider/artifact timing timeline.

See [the handover note](finny-handover-2026-10-30.md) for blockers and continuation steps.
