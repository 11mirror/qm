# Finny Pi harness handover

Date: 2026-10-30

Source branch: `codex/qm-host-attestation`

## Executive status

The host-attested finance harness is implemented, including durable credential rebinding, stage checkpoints, evidence custody, and delivery attestation. The user-facing finance product is still blocked on reviewed AR semantics and live deployment acceptance.

Observed acceptance failure:

> "what's our open AR for Example Manufacturing as at 15-Sep-2025"

`Example Manufacturing` and the cutoff above are synthetic acceptance fixtures.

Finance IR now preserves the AR measure, named entity, and historical cutoff. The compiler still returns `schema_mapping_required` and makes no source call because the executable registry has no finance-reviewed NetSuite field, join, currency, book, entity, or cutoff semantics for this request family. This is safe fail-closed behavior, but it does not meet the product requirement.

Do not report this build as “the finance product works.” Report it as: **host orchestration and durable custody implemented; AR capability authority and live deployment acceptance incomplete**.

## What was implemented

The implementation inventory and source links are in [Finny Pi harness implementation status](finny-implementation-status.md).

The architectural change is real: Pi sees one `finance({request})` operation, while the host compiles and drives the Golden Loop. Seven internal `FinanceService` stages remain as host and compatibility-test seams; they are not model-visible.

The build contains reviewed skill-bundle loading, typed Finance IR, a reviewed capability/schema registry, exact approval binding, crash-resumable stage checkpoints, durable credential rebinding, evidence custody, repeat-pull/accounting verification, artifact publication, safe health/trace APIs, typed provider diagnostics, Slack delivery attestation, and bounded autoresearch scaffolding.

## Why the screenshot fails

Knowledge and execution authority are separate:

1. The skill bundle contains deployment-provided finance knowledge and task rules.
2. Finance IR represents request dimensions.
3. The compiler executes only registry entries backed by reviewed schema authority and deterministic queries.

Only current aggregate AP has such an entry. Skill prose is not sufficient authority to invent SuiteQL or NetSuite mappings. The next build must turn finance-reviewed rules into reusable compiler primitives and registry entries.

## P0 blockers

### 1. Implement the failed acceptance capability family

The first target is the exact failed request family:

- accounts receivable / open receivables;
- named entity such as the synthetic `Example Manufacturing` fixture;
- explicit `as_of` cutoff;
- aggregate total first, then invoice detail;
- NetSuite plus reviewed synthetic legacy-ERP migration inclusion where required;
- AR subledger/control-total verification plus independent repeat pull.

Required work:

- Parse human dates such as `15-Sep-2025` and unambiguous named entities into Finance IR.
- Add reviewed NetSuite schema authority for AR population, applications/credits, entity/subsidiary, accounting book, currency, cutoff semantics, and migration markers.
- Add deterministic compiler primitives rather than a report-specific raw query.
- Register current/as-of aggregate AR, then detailed AR.
- Add frozen positive, negative, boundary, and injection cases. Unsupported dimensions must never silently broaden a query.
- Validate against a safe non-production NetSuite account and finance-owned expected totals.

### 2. Prove deployment-owned credentials and provider behavior live

The source implementation requires Postgres-backed sessions and runs, a stable `CONNECTOR_SECRET_KEY`, and an operator-selected positive `FINNY_PROVIDER_TIMEOUT_MS`. Restart tests prove that opaque credential bindings survive process replacement, and typed provider failures retain safe status/cause diagnostics without upstream bodies or secrets. Each provider request receives a fresh configured deadline so a stalled dependency cannot hold the serialized run indefinitely.

The current development environment has no deployment-owned NetSuite binding or usable model credential. Bind a read-only credential in a safe non-production account, then prove the real 401, 429, timeout, 5xx, pagination, and successful SuiteQL paths without reading or logging secret values.

The supported configuration matrix is documented in [Finny Pi harness implementation status](finny-implementation-status.md#configuration-contract). In short, Finny uses the existing `PI_MODEL` setting as its sole pinned model owner, requires the Pi harness plus Postgres session/run stores and a stable connector secret, requires a positive provider timeout, and optionally accepts a reviewed skills directory.

### 3. Prove a live desktop acceptance matrix

Run from installed QM, not only fixtures:

- supported AP current;
- supported AR as-of for the synthetic entity fixture;
- unsupported/unmapped request;
- missing and invalid NetSuite credential;
- provider 401/429/timeout/5xx;
- repeat-pull mismatch;
- artifact-required and artifact-optional paths;
- approval pause/resume;
- core restart between stages;
- no figure before `DELIVERY_ELIGIBLE`.

Capture safe run/trace IDs without finance rows or credentials.

## P1 blockers

- Add receipts, AR aging, synthetic legacy-ERP migrated invoice inclusion, currency/entity/book selection, and reusable reconciliation primitives.
- Add the ordered queue → retrieval → compile → approval → provider → artifact → verification → delivery timeline.
- Route capability/readiness questions outside finance release gating.
- Prove the implemented Slack trusted ingress and delivery receipts through the configured development workspace after desktop acceptance passes.
- Feed corrected/failed traces to autoresearch while keeping promotion human-reviewed and frozen-eval gated.

## Required acceptance environment

- an installed QM desktop build using the Pi Finny profile;
- Postgres-backed sessions, runs, credential custody, and evidence bytes;
- a working pinned model credential;
- an opaque read-only NetSuite credential binding for a safe non-production account;
- browser and Slack surfaces configured for parity checks.

Never add credential values or copied process environments to Git.

## Verification commands

```bash
node --experimental-test-module-mocks --test test/finny-*.test.ts test/pi-native-tools.test.ts
npm run typecheck
npm run lint -- --quiet
npm run format:check
git diff --check
```

Re-run after every capability change; historical counts are not evidence for new changes. The PR records the exact focused and Postgres-backed results for its reviewed head.

## Continuation order

1. Obtain finance review for AR-as-of/entity schema authority and compiler semantics.
2. Implement that compiler family with tests first.
3. Bind deployment-owned read-only NetSuite and model credentials through QM.
4. Validate AR for a synthetic entity fixture against finance-owned expected data.
5. Run the installed-desktop matrix, including restart and provider failures.
6. Prove Slack parity and attestation in Firefox.
7. Expand capabilities deliberately; never use model-generated SQL.

## Definition of done

Call the harness working only when installed QM can answer a deployment-owned open-AR-as-of acceptance request from NetSuite, show reviewed scope/cutoff, pass independent verification, release only after `DELIVERY_ELIGIBLE`, survive restart without losing credential presence, and reproduce the governed outcome through Slack.
