# Finny Pi harness handover

Date: 2026-10-30

Source branch: `codex/qm-host-attestation`

## Executive status

The host-attested finance harness is now general and plan-native. Finny requires a reviewed capability catalog, accepts only its strict typed intent candidates, derives request identity solely from trusted turn text, and requires human approval before source work. The production path compiles the complete operation graph, executes and checkpoints each primitive durably, verifies a result-connected independent repeat/reconciliation control, and releases only the designated result. AP and an unrelated inventory capability prove that this is not a report-by-report TypeScript controller.

The harness is still not live-validated with a real authenticated Pi model. The running development environment has no usable model credential, no deployment-owned NetSuite binding, no Slack pool slot, and no Firefox acceptance surface. The user-facing finance product is additionally blocked on finance-reviewed AR semantics.

Observed acceptance failure:

> "what's our open AR for Example Manufacturing as at 15-Sep-2025"

`Example Manufacturing` and the cutoff above are synthetic acceptance fixtures.

The installed capability catalog has no reviewed AR intent contract or NetSuite field, currency, book, entity, cutoff, or migration semantics for this request family. An AR proposal therefore fails before any source call. This is safe fail-closed behavior, but it does not meet the product requirement.

Do not report this build as “live Pi works” or “the finance product works.” Report it as: **the general plan-native harness is implemented and locally verified; real Pi authentication, AR capability authority, and live provider/surface acceptance are incomplete**.

## What was implemented

The implementation inventory and source links are in [Finny Pi harness implementation status](finny-implementation-status.md).

The architectural change is real: Pi sees one `finance({capabilityId, dimensions, artifactFormat?})` operation, while the host compiles and drives the Golden Loop. The typed candidate is untrusted until the host validates it against the exact reviewed descriptor and a human approves the complete plan; request identity still comes only from trusted turn text. The plan-only `FinanceService` has no query-era compatibility stages.

The build contains reviewed knowledge and capability-pack loading, catalog-driven intent resolution, deterministic operation-plan compilation, exact approval binding, durable per-operation result custody, crash-resumable stage checkpoints, credential rebinding, repeat-pull/reconciliation verification, artifact publication, safe plan-native trace APIs, typed provider diagnostics, Slack delivery attestation, and bounded autoresearch scaffolding.

## Why the screenshot fails

Knowledge and execution authority are separate:

1. The skill bundle contains deployment-provided finance knowledge and task rules.
2. The capability descriptor defines a strict typed intent and supported dimensions.
3. The compiler executes only exact capability IDs backed by reviewed schema authority and deterministic queries.

The bundled pack contains current aggregate AP and an unrelated inventory capability. Both traverse the same three primitives and controller. Skill prose is not sufficient authority to invent SuiteQL or NetSuite mappings; AR must arrive as reviewed deployment-owned capability and typed-intent data, not another host code path.

`FINNY_SKILLS_DIR` is an operator-controlled deployment trust root. The capability manifest binds exact bytes and detects mutation, but its self-declared classification is not a signature and does not make an untrusted writable directory reviewed.

## P0 blockers

### 1. Prove the real Pi harness boundary

Install a usable credential for the pinned `PI_MODEL`, activate the Finny profile with the reviewed skills directory, and run a real turn. Acceptance requires proof that Pi sees only `finance({capabilityId, dimensions, artifactFormat?})`, the host validates and executes the reviewed plan, and no model-authored figure bypasses `DELIVERY_ELIGIBLE`.

### 2. Prove capability-pack generality

Do not create sequential AR, AP, receipts, and aging controller projects. The core exit criterion is that one reviewed descriptor can be added or changed without changing TypeScript control flow and can traverse the same intent, approval, execution, verification, custody, and delivery path.

AP and an unrelated inventory measure provide local structural evidence today. After the real Pi proof, the first finance-owned live descriptor should cover the failed open-AR/entity/as-of request family because it exercises the important semantic dimensions. Its NetSuite population, applications and credits, entity or subsidiary, accounting book, currency, cutoff, migration markers, result grain, and controls must be supplied as reviewed deployment data. Unsupported dimensions must fail closed. The host must not parse finance prose into a parallel IR, accept model-generated SQL, or add capability-specific branches.

### 3. Prove deployment-owned credentials and provider behavior live

The source implementation requires Postgres-backed sessions and runs, a stable `CONNECTOR_SECRET_KEY`, and an operator-selected positive `FINNY_PROVIDER_TIMEOUT_MS`. Restart tests prove that opaque credential bindings survive process replacement, and typed provider failures retain safe status/cause diagnostics without upstream bodies or secrets. Each provider request receives a fresh configured deadline so a stalled dependency cannot hold the serialized run indefinitely.

The current development environment has no deployment-owned NetSuite binding or usable model credential. Bind a read-only credential in a safe non-production account, then prove the real 401, 429, timeout, 5xx, pagination, and successful SuiteQL paths without reading or logging secret values.

The supported configuration matrix is documented in [Finny Pi harness implementation status](finny-implementation-status.md#configuration-contract). In short, Finny uses the existing `PI_MODEL` setting as its sole pinned model owner and requires the Pi harness, a reviewed skills directory, Postgres session/run stores, a stable connector secret, and a positive provider timeout.

### 4. Prove a live desktop acceptance matrix

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

1. Supply a working pinned model credential and prove one real Pi turn through the catalog-enabled production controller.
2. Complete fresh-context correctness, security, durability, and Wall of shame reviews for the current plan-native head; resolve all findings in parallel with environment preparation.
3. Prove that additional reviewed descriptors require no capability-specific TypeScript control flow; keep capability semantics in the deployment-owned pack.
4. Obtain finance review for AR-as-of/entity/currency/book/migration authority, bind a read-only NetSuite credential, and validate the descriptor against finance-owned expected data.
5. Run the installed-desktop matrix, including restart and provider failures.
6. Prove Slack parity and attestation in Firefox.
7. Expand capabilities deliberately through reviewed pack data; never use model-generated SQL.

## Definition of done

Call the architecture implemented now, but call the live harness working only after installed QM completes a real authenticated Pi turn through the catalog-enabled controller. Call the finance acceptance complete only when it can additionally answer a deployment-owned open-AR-as-of request from NetSuite, show reviewed scope/cutoff, pass independent verification, release only after `DELIVERY_ELIGIBLE`, survive restart without losing credential presence, and reproduce the governed outcome through Slack.
