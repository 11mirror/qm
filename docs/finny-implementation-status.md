# Finny Pi harness implementation status

Last updated: 2026-10-30

This records what is present in the QM source tree. It is implementation evidence, not a claim that Finny is production-ready.

## Harness verdict

The general Pi-native controller is wired into production and passes synthetic and integration tests. A reviewed capability pack now owns a strict typed intent contract, deterministic operation-plan compilation, durable per-operation execution, evidence custody, independent verification, trace, and host-owned release gating. AP and an unrelated inventory measure traverse the same controller without capability-specific TypeScript branches. There is no production legacy registry or prose-parser fallback.

It is not yet proven with a real authenticated Pi model. The running development instance has no usable model credential. This is now an acceptance blocker rather than an architectural dependency: the production plan-native path exists and is locally executable when `FINNY_SKILLS_DIR` supplies the reviewed catalog.

## Goal execution sections

| Section                               | Exit evidence                                                                                                                                                                                                                         | Current state                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Real Pi harness                    | An installed QM instance with `profile=finny` and a non-placeholder pinned model completes a real Pi turn, invokes only the native `finance` controller, and releases only host-rendered `DELIVERY_ELIGIBLE` output.                  | **Blocked externally.** The running instance is healthy on Pi with Postgres sessions/runs, but Finny activation is unset and every available model credential source is empty or placeholder.                                 |
| 2. Skill-driven finance controller    | A manifest-digested capability pack adds a synthetic measure without TypeScript branches; the host compiles and executes a reviewed operation graph whose identity is bound into approval, checkpoints, evidence, and trace.          | **Implemented and locally verified.** AP and unrelated inventory descriptors use one production controller, operation runner, durable result custody, and release policy. Live Pi/provider proof remains in Sections 1 and 3. |
| 3. Live read-only NetSuite acceptance | The installed instance answers the governed open-AR/entity/as-of request from deployment-owned NetSuite data with reviewed entity, cutoff, currency, book, and migration semantics plus independent repeat-pull/control verification. | **Not started.** No read-only NetSuite binding or finance-reviewed capability pack is installed.                                                                                                                              |
| 4. Restart and desktop matrix         | Credential presence, diagnostics, every host checkpoint, approval resume, provider failures, artifacts, and final evidence survive process replacement and pass the defined desktop matrix.                                           | **Partially verified.** Durable stores and synthetic restart tests pass; installed-desktop failure/restart evidence is missing.                                                                                               |
| 5. Trusted Slack parity               | The same controller, capability digest, evidence, and final host-rendered result traverse trusted Slack ingress and produce an attested delivery receipt in Firefox.                                                                  | **Implemented in code, not live-proven.** No Slack pool slot or Firefox is available in the current environment.                                                                                                              |

Sections are gates, not independent report implementations. AR, AP, receipts, and aging must share the Section 2 compiler and operation primitives; a new reviewed capability should normally be data in a deployment-owned pack rather than a new code path.

## Orchestration DAG

| Lane                               | Ownership                                                                                                                             | Dependency                             | Completion condition                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A. Capability authority            | Reviewed pack schema, manifest and digest validation, parameter bindings, AP compatibility descriptor, unrelated synthetic descriptor | None                                   | Both descriptors load through the same schema; unsafe or ambiguous packs fail closed.                                                     |
| B. Intent resolution               | Catalog-driven capability and dimension resolution                                                                                    | None                                   | Arbitrary reviewed aliases resolve without measure branches; ambiguity and missing mappings are typed failures.                           |
| C. Operation compilation           | Deterministic host-owned parameter binding and operation-plan digests                                                                 | A                                      | The model cannot supply SQL or parameters; equivalent inputs compile identically and hostile values remain data.                          |
| D. Controller integration          | One native `finance` tool from typed proposal through reviewed plan                                                                   | A, B, C                                | **Complete.** The production Pi profile requires the pack path and has no legacy registry fallback.                                       |
| E. Durable execution               | Primitive execution, checkpointing, approval/evidence/trace binding, repeat pull and reconciliation                                   | D                                      | **Complete in local tests.** Every completed primitive resumes idempotently and release requires the reviewed plan's verification policy. |
| F. Real Pi proof                   | Installed profile with a usable pinned model credential                                                                               | D, E, external model credential        | A real Pi turn invokes only `finance` and only host-rendered eligible evidence reaches the user.                                          |
| G. Provider and surface acceptance | Finance-reviewed AR pack, read-only NetSuite binding, desktop matrix, Slack pool and Firefox                                          | E, F, external provider/surface access | The exact governed AR request passes live NetSuite, restart, web and Slack acceptance with the same plan and evidence identities.         |

Lanes A, B, and C run in parallel. Lane D is the convergence point. Lanes F and G are acceptance work, not alternate finance implementations.

## Implemented

- The Finny profile uses QM's Pi harness and exposes only the native `finance` tool.
- The model-visible finance input is `{capabilityId, dimensions, artifactFormat?}`; free-form request text is never model-supplied tool authority.
- The host owns typed-intent validation, capability compilation, Golden Loop transitions, approval, source custody, artifact policy, verification, and release.
- A separate reviewed capability sub-bundle defines semantic aliases, dimension support, a fixed operation graph, host-owned parameter bindings, artifact policy, approval policy, and verification policy. The production controller resolves and executes AP and an unrelated synthetic measure through the same data-driven path.
- The operation plan is canonical and binds the manifest, catalog, capability revision, dimensions, parameters, full operation graph, result operation, and artifact, approval, and verification policies.
- Native execution supports only the primitives used by installed reviewed packs: `suiteql_select`, `repeat_pull`, and `reconcile`. Projection, filtering, aggregation, and joins remain inside reviewed SuiteQL rather than a second host relational engine. Only the designated result operation is released; a result-connected independent repeat and reconciliation gate verification.
- Each operation result is stored as a canonical `finny.operation_result.v1` envelope before its stable `operation_completed` checkpoint. Resume validates custody and dependencies, skips committed operations, and reruns an operation only when no stable completion event exists.
- Reviewed finance knowledge is loaded from the content-addressed `finny-skills` bundle with ranked section retrieval, provenance, and no silent default truncation.
- NetSuite credentials are read through QM service-credential custody; values are not placed in prompts, traces, or durable summaries. Approval preflight is local and reads no provider credential.
- Finny requires Postgres-backed sessions and runs plus a stable `CONNECTOR_SECRET_KEY`. Credentials, safe diagnostics, full Golden Loop checkpoints, and private query/source evidence survive process restarts.
- Stable workflow event IDs, a shared per-run advisory lock, and deterministic artifact identities prevent overlapping workers from duplicating stage work; a resumed run starts at its first incomplete stage.
- Typed failures distinguish unsupported capability, missing schema mapping, credential/configuration faults, provider faults, verification failure, and policy blocks.
- Provider HTTP and transport failures retain allowlisted cause, retryability, dependency, and status metadata in durable diagnostics without copying upstream bodies or credential material.
- Finny startup requires an operator-selected positive `FINNY_PROVIDER_TIMEOUT_MS`; every live provider request receives a fresh deadline so a stalled dependency cannot hold the durable run lock indefinitely.
- Finny-created artifact bytes use namespaced durable custody.
- Slack acknowledgements retain provider receipts that bind exact rendered content and uploaded file digests to delivery attestation, including reconstruction from the posted Slack thread after a process restart loses the original acknowledgement.
- Safe trace v3 exposes plan authority, ordered operation-result digests, approval state, and verification state without SQL, parameters, records, or credentials. Trace v2 remains readable for compatibility. `/v1/finny/health` and bounded offline autoresearch scaffolding are implemented.

## Configuration contract

Finny is opt-in. `FINNY_PROFILE=finny` selects the profile and requires `HARNESS=pi` or the default Pi harness. `PI_MODEL` is the single model setting for both the Finny profile and Pi; it must be set to the pinned deployment model. There is no Finny-specific model override or precedence rule.

`FINNY_PROVIDER_TIMEOUT_MS` is required and must be a positive integer. It applies independently to each NetSuite page request. `FINNY_SKILLS_DIR` is required for the Finny profile, resolves to an absolute path, and supplies both reviewed knowledge and the manifest-digested capability catalog under `capabilities/`. Every Finny run uses the plan-native controller and durable evidence custody.

The operator-controlled `FINNY_SKILLS_DIR` deployment is the capability-review trust root. Manifest sizes and hashes provide content identity and mutation detection inside that trusted deployment; they do not authenticate an untrusted directory or replace human review, signing, or deployment access control.

The profile accepts only durable runtime combinations: `DATABASE_URL` must be present, `SESSION_STORE` and `RUN_STORE` must both resolve to `postgres`, and `CONNECTOR_SECRET_KEY` must be stable across process replacements. `FINNY_SKILLS_DIR` and `FINNY_PROVIDER_TIMEOUT_MS` are rejected unless the Finny profile is selected. With `FINNY_PROFILE` unset, the existing Pi configuration remains unchanged and `PI_MODEL` retains its normal meaning.

Key source links:

- [`src/finny/native-finance-tool.ts`](../src/finny/native-finance-tool.ts) — one-call host orchestration and approval resume.
- [`src/finny/capability-pack.ts`](../src/finny/capability-pack.ts) — reviewed catalog and manifest authority.
- [`src/finny/intent-resolver.ts`](../src/finny/intent-resolver.ts) and [`src/finny/controller-compiler.ts`](../src/finny/controller-compiler.ts) — generic intent and plan compilation.
- [`src/finny/operation-runner.ts`](../src/finny/operation-runner.ts) and [`src/finny/durable-operation-runner.ts`](../src/finny/durable-operation-runner.ts) — graph execution and crash-safe result checkpoints.
- [`src/finny/golden-loop.ts`](../src/finny/golden-loop.ts) — host-owned ledger/reducer.
- [`src/finny/run-store.ts`](../src/finny/run-store.ts) — durable stage checkpoints and per-run serialization.
- [`src/finny/pi-profile.ts`](../src/finny/pi-profile.ts) — Pi restriction, knowledge injection, and release suppression.
- [`src/finny/credential-brokered-finance-service.ts`](../src/finny/credential-brokered-finance-service.ts) — opaque credential boundary.
- [`src/finny/evidence-backed-finance-service.ts`](../src/finny/evidence-backed-finance-service.ts) — evidence custody, artifacts, repeat pull, and accounting verification.
- [`src/finny/knowledge-index.ts`](../src/finny/knowledge-index.ts) — reviewed knowledge index.
- [`src/finny/autoresearch.ts`](../src/finny/autoresearch.ts) — bounded offline candidate evaluation.
- [`test/finny-finance-run.test.ts`](../test/finny-finance-run.test.ts) and [`test/finny-web-path.test.ts`](../test/finny-web-path.test.ts) — host-run and real QM/Pi web-path coverage.

## Verified boundary

Focused tests pass for one model-visible call, reviewed plan compilation, AP and unrelated inventory traversal through the same production path, exact approval binding, stable workflow identity across resume, changed-catalog rejection, per-operation result recovery, typed terminal failures, and safe plan-native trace exposure. A fresh independent review of the current head is still required before merge.

No SQL schema or index changed. Persisted/API shapes added by this work are `finny.run.v2` with catalog/capability/revision/graph/plan binding, `finny.operation_result.v1` with dependency and output custody, `finny.source.v2` with the designated result only, and `finny.trace.v3` with safe plan and attestation metadata. Query-era v1 run/source contracts were removed before deployment; trace v2 remains readable for existing safe diagnostics. No live stored field is migrated or dropped.

The model-visible finance call changed from `{request}` to `{capabilityId, dimensions, artifactFormat?}`. Capability descriptors now include a strict `intent` declaration whose dimensions are `enum`, `string`, `date`, or `string_list`; aliases cannot authorize execution. The operation union now contains only `suiteql_select`, `repeat_pull`, and `reconcile`. These are deliberate breaking internal/profile contracts with no backfill: Finny is opt-in, requires a newly loaded reviewed pack, and no production v1 run/source path remains.

## Not production-ready

- Open AR by entity and historical cutoff has no finance-reviewed capability descriptor.
- Receipts, aging, synthetic legacy-ERP migrated invoices, detailed grain, entity/book/currency selection, and most other skill-described tasks are not compiled.
- Live provider acceptance requires deployment-owned NetSuite credentials and optional advisory-provider credentials bound through QM; this source change includes no such bindings.
- A process crash after a read returns but before its durable operation-completion event can repeat that read. The read is side-effect-free; a committed result plus stable event resumes without repeating work, and overlapping workers are serialized by run.
- Slack ingress and delivery attestation are implemented, but live Firefox/Slack parity evidence is not available in the current development environment.
- The safe trace is not yet the complete queue/model/provider/artifact timing timeline.

See [the handover note](finny-handover-2026-10-30.md) for blockers and continuation steps.
