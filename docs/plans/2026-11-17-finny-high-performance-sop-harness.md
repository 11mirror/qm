# Finny High-Performance SOP Harness

Status: Active design and implementation tracker
Created: 2026-11-17
Last updated: 2026-11-18
Owner: Finny/QM working agents
Implementation state: Phase 0 and Phase 1 verified on QM web and Slack; the approved Phase 2 SOP slice is implemented and verified on the production-shaped QM web surface
Working branch: `codex/finny-sop-v1`
Working tree: `/Users/kalicharanshukla/.codex/worktrees/finny-architecture-audit/QM`
Phase 0/1 implementation commit: `4e0fbbbb9`
Review PR: [11mirror/qm#34](https://github.com/11mirror/qm/pull/34)

## Implementation summary

This table is the quick handoff. Follow the links for design, implementation, and measured evidence.

| Area                  | Done                                                                                                                                | Where and evidence                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research              | Audited downstream Finny, current upstream QM, Pi execution, and LoopForge SOP patterns                                             | [Evidence baseline](#evidence-baseline) and [architectural position](#architectural-position)                                                                                                                             |
| Phase 0               | Added fail-closed measurement of worker turns, pre-artifact Auditor starts, certified-delivery time, and per-role tokens            | [Analyzer](../../evals/finny-high-performance-v1/baseline.mts), [tests](../../test/finny-phase0-baseline.test.ts), and [eval design](#finny-high-performance-eval-v1)                                                     |
| Tool contract         | Replaced imaginary standalone Finny tools with the real `finny(action="...")` contract                                              | [Finny tool](../../src/agent/agent-tools/finny.ts), [seed skill](../../skills-seed/finnyloop/SKILL.md), and [Phase 1 details](#phase-1--remove-accidental-pi-work)                                                        |
| Worker lifecycle      | Approval now starts one actionable Producer; artifact commit starts one actionable Auditor                                          | [Runtime coordinator](../../src/finny/runtime-coordinator.ts), [runtime store](../../src/finny/runtime-postgres-store.ts), and [lifecycle tests](../../test/finny-runtime-coordinator.test.ts)                            |
| Durable recovery      | Successful-but-incomplete terminal worker runs are reconciled from durable job state without placeholder turns                      | [Integration](../../src/finny/integration.ts), [integration store](../../src/finny/integration-postgres-store.ts), and [recovery tests](../../test/finny-integration-runtime.test.ts)                                     |
| Web approval          | Preserved the durable Finny request identity and projects the ready plan immediately after a material clarification                 | [Orchestrator](../../src/core/orchestrator.ts), [approval service](../../src/finny/approval-service.ts), [regression test](../../test/finny-web-approval.test.ts), and [web evidence](#phase-01-live-measurement--qm-web) |
| Live web result       | Certified XLSX delivered with one Producer and one post-artifact Auditor; total tokens fell 21.6% in the paired run                 | [Web baseline and candidate](#phase-01-live-measurement--qm-web)                                                                                                                                                          |
| Live Slack result     | Certified XLSX attached in the 11mirror `finny-staging` DM with one Producer and one post-artifact Auditor; total tokens fell 43.2% | [Slack baseline and candidate](#phase-01-live-measurement--slack)                                                                                                                                                         |
| Verification          | Phase 1 focused suites, typecheck, ESLint/oxlint, FinnyLoop r5, and real Chrome web plus Slack QA pass                              | [Running implementation log](#running-implementation-log) and [r5 manifest](../../evals/finnyloop-r5/manifest.json)                                                                                                       |
| Schema/config         | No database schema, persisted payload, or configuration change in Phase 0/1                                                         | [Phase 0/1 evidence](#phase-01-live-measurement--qm-web)                                                                                                                                                                  |
| Phase 2               | Immutable finance SOP versions, exact job and approval binding, material-amendment invalidation, and role-specific compilation are implemented and verified | [Phase 2](#phase-2--durable-sop-creation-and-execution), [schema gate](#phase-2-sop-and-job-schema-gate), and [running log](#running-implementation-log) |
| Next gate             | Complete independent PR review and Slack acceptance; keep the corpus and later audit/result schemas behind their own human gates | [Phase 2](#phase-2--durable-sop-creation-and-execution) and [human decisions](#required-human-decisions-for-phase-2-gates)                                                                                             |
| Next-session handover | Phase 2 execution order, guardrails, schema gate, verification, and definition of done                                              | [Finny Phase 2 SOP implementation handover](./2026-11-18-finny-sop-phase-2-handover.md)                                                                                                                                   |

## How to use this document

This is the running implementation artifact for restoring Finny performance while preserving the existing QM parent → Producer → Auditor architecture.

Every agent working on this initiative must:

1. Read `docs/SPEC.md`, `CODING_STANDARDS.md`, `REVIEW.md`, and this document before changing code.
2. Work on only one phase or explicitly named implementation unit at a time.
3. Update the implementation summary plus the detailed phase status, evidence, decisions, verification results, and open risks before handing work off.
4. Distinguish proposed design, implemented code, locally verified behavior, and deployed behavior.
5. Keep the current Finny topology. The separate `finny-staging` deployment proposal is outside this initiative.
6. Prefer deleting protocol and redundant state over adding another workflow layer.
7. For Phase 2 execution, follow the [SOP implementation handover](./2026-11-18-finny-sop-phase-2-handover.md) and keep this document updated as the running source of truth.

The QM spec wins if this document disagrees with it.

## Objective

Make Finny fast, natural, accurate, and reliably complete across Slack and the QM app while retaining:

- the conversational parent/coordinator;
- an independent Producer child session;
- an independent audit stage, using a Pi Auditor child session only when explicit judgment is required;
- Pi as the execution harness for every agent turn;
- Core-owned durable authority, approvals, artifacts, audit evidence, finalization, and delivery.

Success means a finance request reliably ends with:

- a valid downloadable Excel workbook;
- a concise certified financial summary;
- explicit exceptions and material caveats;
- deterministic spreadsheet evidence;
- an independent audit verdict;
- no orphaned, indefinitely waiting, or falsely completed Finny job.

## Architectural position

Finny should borrow LoopForge's execution discipline, not its workflow engine.

The useful LoopForge pattern is:

> Give the agent freedom inside a durable SOP step, but let deterministic artifact contracts and engine-owned completion decide whether the step advanced.

QM already owns durable runs, sessions, approvals, files, tools, delivery, and Finny JobBook authority. This initiative must not import LoopForge's DAG engine, generic node runtime, nested SOP engine, retry budgets, or prompt-level authority.

## Target flow

```text
Human finance request
    ↓
QM parent resolves or creates a durable SOP
    ↓ human approval when materially required
Producer opens once with the real SOP and deliverable contract
    ↓
Core validates and binds one immutable XLSX artifact
    ↓
Core runs the independent deterministic audit stage
    ├─ no uncertainty → atomic PASS → finalize → workbook + certified summary
    └─ explicit judgment trigger → Pi Auditor opens with one bounded question
            ├─ PASS → atomic audit result → finalize and deliver
            └─ BLOCK → exact failed checks → same Producer session → revised artifact
```

Pi remains the turn harness. Core remains the authority and completion owner.

## Evidence baseline

The following are source-backed findings in downstream QM at commit `f2d342f93d7b4dfe157cf5ca831110b565f7603d`:

1. The callable catalog exposes one `finny` tool with actions, while several prompts and skills name nonexistent standalone tools.
2. Approval opens Producer and Auditor placeholder sessions, and `open()` enqueues a real Pi turn for each.
3. Auditor is opened before an artifact exists even though its authoritative grant requires an artifact.
4. A worker can end successfully without completing its required Finny transition; recovery focuses on failures, stops, expiry, and interrupted dispatch.
5. Finny records eight separate checks. Deterministic checks repeatedly reopen and verify the same artifact and evidence envelope.
6. Rework generation invalidation and artifact-digest finalization rules overlap, effectively forcing full reaudit after every revised artifact.
7. Final delivery labels an artifact as XLSX without Core enforcing XLSX at the artifact boundary.
8. Final delivery contains certification metadata but no typed certified business summary.
9. There is no committed prod-like acceptance test proving one real prompt ends with a valid workbook and certified summary.

LoopForge research source: `/Users/kalicharanshukla/Documents/ChatGPT/loopforge` at `86b0ee06`.

Relevant LoopForge patterns:

- SOP nodes carry role, deliverables, checks, retry/rework routing, and artifact contracts.
- Agent work remains natural inside the node.
- Objective gates run outside model judgment.
- Missing terminal submission resumes the same session rather than rerunning the work.
- Failed gates return exact feedback to the same workspace.
- The engine, not agent prose, owns completion.
- Artifacts are collected only after their contracts and gates pass.

Latest researched upstream QM: `b3ba0524073d634d420356de65bab8192e8d8eff`.

The downstream branch has diverged substantially from upstream. Upstream changes must be adapted selectively; a wholesale sync is outside this plan.

## Recommended high-performance plan

### 1. Remove accidental friction first

No schema change required.

- Replace every imaginary Finny tool name with `finny(action="...")`.
- Open only the Producer after approval, with the actual production task.
- Open the Auditor only after a valid artifact is committed.
- Remove both “Await dispatch” Pi turns.
- Give Producer one SOP-led prompt containing:
  - objective;
  - source systems and accounting logic;
  - required workbook structure;
  - deliverables;
  - deterministic acceptance criteria.
- Validate XLSX type and structure at the artifact boundary.

This should immediately reduce latency and tool confusion.

### 2. Make job state own completion

A role finishing its Pi response must not imply its Finny stage completed.

When a worker run ends, reconcile from durable state:

- Approved but no artifact → Producer work remains.
- Artifact present but audit incomplete → Auditor work remains.
- BLOCK with pending rework → Producer work remains.
- All required evidence present → finalize and deliver.

This closes the main permanent-stall condition without creating another workflow engine.

### 3. Collapse audit overhead

This would affect persisted audit payloads and therefore needs explicit human review before implementation.

- Run deterministic formula, crossfoot and structure checks once.
- Let the Auditor perform the judgment-heavy checks.
- Submit one atomic audit result containing every check and its evidence.
- Verify the artifact and deterministic envelope once.
- Finalize from that transaction.
- On BLOCK, send only exact failed checks, evidence references and repair instructions back to the same Producer session.

### 4. Make the final deliverable a product contract

Final success should always produce:

- A verified XLSX workbook.
- A typed certified summary: period, currency, totals, exceptions and material caveats.
- Audit result and receipt.
- One durable delivery record.

Finalization and delivery should not be separable failure windows.

### Selective upstream improvements

Latest upstream is `b3ba0524`. This checkout is 804 upstream commits behind and has 126 downstream-only commits, so a wholesale merge is unsafe.

The strongest pieces to adapt selectively are:

- `54cba6b98`: steer corrections into a running worker instead of queueing another turn.
- `61eb435f2`: generic durable session-work/progress projection.
- `741c843dc`: stable system-prompt snapshots for better model-cache latency.
- `0950fa057`: preserve a session's runtime across resumed turns.
- `d5bca76a3`, `ce54d34a5`, `70a834594`: stop/retry/restart correctness.

The first implementation slice is: correct tool vocabulary, lazy worker creation, real first-turn tasks, and durable incomplete-stage recovery. This is the smallest change set most likely to make Finny feel natural and fast again.

## Durable SOP design

### Principle

The SOP is not a long prompt. It is versioned job input that survives model turns, process restarts, compaction, Producer/Auditor handoffs, and rework.

The model may propose an SOP. Core validates and persists it. The approved SOP becomes the shared contract for Producer, Auditor, deterministic checks, final summary, and human review.

### Approved minimal SOP shape

This is the selected design direction. It remains a proposed persisted/API shape and requires the repository's human schema review before implementation.

```ts
interface FinnySopVersion {
  schema: "finny.sop.v1";
  id: string;
  version: number;
  scopeId: string;
  title: string;
  intent: {
    domain: "ap" | "ar" | "gl" | "close";
    description: string;
    searchTerms: string[];
  };
  objective: string;
  inputs: Array<{
    id: string;
    label: string;
    from: "human" | "system";
    type: "date" | "text" | "currency" | "entity" | "boolean";
    required: boolean;
    material: boolean;
  }>;
  sources: Array<{
    id: string;
    system: string;
    object: string;
    fields: string[];
    filter: string;
    asOfInput?: string;
  }>;
  steps: Array<{
    id: string;
    action: string;
    reads: string[];
    writes: string;
  }>;
  controls: Array<{
    id: string;
    assertion: string;
    tolerance?: string;
    evidenceRefs: string[];
    judgment?: {
      question: string;
      onlyWhen: string;
    };
  }>;
  outputs: Array<{
    id: string;
    kind: "xlsx" | "summary" | "app";
    contract: Record<string, unknown>;
    rerun?: { inputIds: string[] };
  }>;
  approval: { required: true; destination: string };
}

interface FinnyJobInputs {
  sopVersionId: string;
  values: Record<string, string | boolean>;
}
```

Why these fields earn persistence:

- `intent` is the searchable reuse surface during decomposition; it is not runtime routing authority.
- `inputs` declares external and human facts without embedding per-run values in the reusable SOP.
- `sources` identifies systems of truth such as NetSuite and defines the required population.
- ordered `steps` express task execution without DAGs, dependencies, node types, or retry rules.
- `controls` holds objective assertions and adds `judgment` only where deterministic resolution is impossible.
- `outputs` defines the workbook, certified summary, and optional rerunnable mini app/report contract.
- `rerun.inputIds` means a new job can reuse the same immutable SOP version with newly bound inputs. It does not create a scheduler or application runtime.
- `approval` remains one task-level decision instead of arbitrary approval nodes.

### Invented example: repeatable AP aging report

The following is an invented example, not a client record or approved production SOP.

```json
{
  "schema": "finny.sop.v1",
  "id": "ap-aging",
  "version": 3,
  "scopeId": "org:invented-media-company",
  "title": "AP aging at cutoff",
  "intent": {
    "domain": "ap",
    "description": "Vendor bill aging and MSME exposure at a period cutoff",
    "searchTerms": ["accounts payable", "vendor aging", "MSME", "cutoff"]
  },
  "objective": "Produce a vendor-level AP aging workbook and certified summary at the approved cutoff.",
  "inputs": [
    { "id": "cutoff", "label": "Cutoff date", "from": "human", "type": "date", "required": true, "material": true },
    {
      "id": "subsidiary",
      "label": "Subsidiary",
      "from": "human",
      "type": "entity",
      "required": true,
      "material": true
    },
    {
      "id": "currency",
      "label": "Presentation currency",
      "from": "human",
      "type": "currency",
      "required": true,
      "material": true
    }
  ],
  "sources": [
    {
      "id": "bills",
      "system": "NetSuite",
      "object": "transaction + transactionline + vendor",
      "fields": [
        "transaction.id",
        "trandate",
        "duedate",
        "amountremaining",
        "subsidiary",
        "currency",
        "vendor.custentity_sc_acl_msme"
      ],
      "filter": "posting='T' AND type='VendBill' AND amountremaining<>0 AND account<>606702",
      "asOfInput": "cutoff"
    }
  ],
  "steps": [
    {
      "id": "extract",
      "action": "Query the approved NetSuite population and record query, row count and control total.",
      "reads": ["bills", "cutoff", "subsidiary"],
      "writes": "source_manifest"
    },
    {
      "id": "age",
      "action": "Compute DPD as cutoff minus due date and assign approved buckets.",
      "reads": ["source_manifest", "cutoff"],
      "writes": "aged_rows"
    },
    {
      "id": "render",
      "action": "Write Detail, Summary and Exceptions sheets plus cached summary values.",
      "reads": ["aged_rows", "currency"],
      "writes": "workbook"
    }
  ],
  "controls": [
    {
      "id": "source-total",
      "assertion": "Detail amount equals source control total",
      "tolerance": "0.01",
      "evidenceRefs": ["source_manifest.total", "Detail.amount"]
    },
    {
      "id": "summary-crossfoot",
      "assertion": "Summary buckets equal Detail amount",
      "tolerance": "0.01",
      "evidenceRefs": ["Summary.total", "Detail.amount"]
    },
    {
      "id": "mapping-exception",
      "assertion": "No materially unmapped vendor classification",
      "evidenceRefs": ["Exceptions"],
      "judgment": {
        "question": "Are remaining unmapped classifications materially misleading?",
        "onlyWhen": "Exceptions.material_count > 0"
      }
    }
  ],
  "outputs": [
    {
      "id": "workbook",
      "kind": "xlsx",
      "contract": {
        "sheets": ["Summary", "Detail", "Exceptions"],
        "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    },
    {
      "id": "certified-summary",
      "kind": "summary",
      "contract": { "metrics": ["totalOpenAP", "overdueAP", "msmeAP"], "dimensions": ["agingBucket"], "caveats": true }
    },
    {
      "id": "report",
      "kind": "app",
      "contract": { "views": ["summary", "vendor-drilldown"] },
      "rerun": { "inputIds": ["cutoff", "subsidiary", "currency"] }
    }
  ],
  "approval": { "required": true, "destination": "origin-thread" }
}
```

Invented job binding:

```json
{
  "sopVersionId": "ap-aging@3",
  "values": { "cutoff": "2026-10-31", "subsidiary": "India Media Pvt Ltd", "currency": "INR" }
}
```

A rerun creates a new job against version 3 with new bound inputs. It does not mutate the prior job or silently reuse prior evidence.

### Approval invalidation decision

Approval binds one canonical `executionDigest` computed from:

- objective;
- input declarations and every bound value marked `material`;
- source system, object, fields, filter, and as-of binding;
- ordered step actions, reads, and writes;
- control assertions, tolerances, evidence requirements, and judgment triggers;
- output kinds, contracts, and rerun inputs;
- approval destination.

Changing any of those fields invalidates approval.

Changing only `title`, `intent.description`, or `intent.searchTerms` does not invalidate approval. Non-material bound input values may change without invalidation only when the SOP explicitly declares them non-material; their final values remain recorded in the receipt.

### SOP creation

The parent uses Pi to draft the SOP from the finance request and relevant domain skill. Core then performs structural validation before presenting it for clarification or approval.

SOP creation must:

- identify source systems, records, filters, periods, currencies, and entities;
- state transformations and reconciliation equations;
- define the workbook and summary contracts;
- separate deterministic checks from judgment checks;
- ask only material unresolved questions;
- survive as durable Finny job data rather than prompt-only context.
- define an optional rerunnable report or mini app through an output contract, not bespoke generated workflow code.

The parent must not execute the finance work while creating the SOP.

### SOP execution

Producer receives:

- the approved SOP;
- the exact artifact contract;
- available tools and credentials;
- prior failed checks on rework;
- no redundant governance narrative.

The deterministic audit stage receives:

- the same approved SOP;
- the immutable artifact identity;
- the bound source manifest and output contracts;
- every objective control.

The Pi Auditor session is created only when a control's explicit `judgment.onlyWhen` predicate is true or deterministic evidence cannot resolve the control. It receives the deterministic envelope, the bounded judgment question, materiality context, and evidence references. It cannot rewrite deterministic results or modify the artifact.

The Pi extension continues to project current authoritative state. It does not become the SOP engine or authority owner.

### Deterministic-first audit decision

Each artifact creates one audit attempt:

1. Core reads the artifact once and validates digest, MIME, XLSX ZIP/OOXML structure, required workbook parts, scope eligibility, and SOP output contract.
2. One deterministic worker invocation evaluates independent controls concurrently where their inputs permit it: source-manifest schema and binding, population counts and control totals, required sheets and headers, data types, formulas, detail-to-summary crossfoots, certified-summary metrics, exceptions/caveats, and optional app/report manifests.
3. Core writes one immutable audit envelope containing a verdict, evidence references, and exact repair actions for every control.
4. If every objective control passes and no judgment predicate triggers, the independent Core audit stage finalizes without spending an LLM call.
5. If judgment is required, one Pi Auditor turn produces a structured judgment addendum bound to the same audit attempt.
6. Any BLOCK returns only failed controls, evidence references, and repair actions to the same Producer session. A revised artifact starts a new audit attempt; evidence is never carried across artifact digests.

This changes “Auditor” from “an LLM must always review” to “an independent audit stage must always run.” Pi judgment is used only for explicit uncertainty.

### Certified result and searchable reuse

The SOP defines what must be produced. A separate final result stores what was produced.

```ts
interface FinnyCertifiedResult {
  schema: "finny.result.v1";
  jobId: string;
  sopVersionId: string;
  executionDigest: string;
  artifact: { fileId: string; sha256: string; mime: string };
  summary: {
    period: string;
    currency: string;
    metrics: Array<{ id: string; label: string; value: string; detailRefs: string[] }>;
    exceptions: Array<{ text: string; material: boolean; detailRefs: string[] }>;
    caveats: Array<{ text: string; detailRefs: string[] }>;
  };
  auditAttemptId: string;
}
```

`detailRefs` are stable typed references such as `xlsx:Summary!B7`, `xlsx:Exceptions!A2:D9`, `evidence:source-manifest#control-total`, or `app:vendor-drilldown?bucket=90+`. They may resolve only to bound artifacts and evidence, never arbitrary URLs.

Approved immutable SOP versions are searchable within their organization by title, intent description, search terms, objective, source systems, and source objects. Intent decomposition searches certified-use SOP versions before drafting a new one. A match reuses only the SOP version; each job receives fresh inputs, approval, source evidence, artifact, audit attempt, and result.

Start with PostgreSQL lexical/full-text search. Add embeddings only if measured lexical misses justify them. Draft SOPs remain directly addressable but are not ranked as reusable production SOPs until at least one certified job completes.

### Persistence decision and human schema review

The selected direction is a clean, single-owner model:

- immutable `finny_sop_versions` owns reusable SOP definitions and their execution digests;
- `finny_jobs` references one SOP version and stores only job-bound input values plus existing lifecycle identity;
- `finny_audit_attempts` owns one immutable audit envelope per artifact attempt and an optional judgment addendum;
- `finny_results` owns the certified summary, artifact reference, audit-attempt reference, delivery reference, and searchable detail references;
- `finny_jobs` exposes the current result reference but does not duplicate the complete result payload.

This satisfies the requirement that agents can quickly see the latest SOP and certified output summary while following stable references for detail. Search covers certified SOP versions and certified results. The item log, artifact store, and audit evidence remain their existing owners; the result stores references rather than copying their bodies.

The proposed cutover removes writable per-check attestations and generation counters only after human approval of the complete schema diff. Existing signed final receipts remain historical objects and are never rewritten. Before implementation, the schema review must choose whether unfinished old jobs are migrated into one-off SOP versions or closed before cutover. No dual-read compatibility layer is allowed by default.

### Phase 2 SOP and job schema gate

Status: Approved by the user on 2026-11-18 and implemented on `codex/finny-sop-v1`. The schema is live only in the isolated development acceptance database; it is not deployed.

This review covers only immutable SOP versions, job bindings, approval bindings, amendment provenance, worker compilation inputs, and receipts. It does not authorize or define `finny_audit_attempts` or `finny_results`; those remain separate human gates.

#### Current TypeScript authority

The current persisted job contract is:

```ts
interface FinnyPlanPhase {
  name: string;
  owner: string;
  dependencies: string[];
}

interface FinnyPlanClarification {
  question: string;
  answer: string;
}

interface FinnyPlanPresentation {
  title: string;
  summary?: string;
  phases: FinnyPlanPhase[];
  certification: string;
  deliverable: string;
  destination: string;
  clarifications: FinnyPlanClarification[];
}

interface FinnyJob {
  id: string;
  scopeId: string;
  plan: FinnyPlanPresentation;
  planDigest: string;
  artifactDigest?: string;
  policy: FinnyPolicySnapshot;
  findingPolicy?: FinnyFindingPolicy;
  originThreadRef: string;
  provisionalRevision?: string;
  approval?: FinnyApproval;
  ledgerHead: number;
  eventHead: number;
  pendingReworkSequence?: number;
  unresolvedEscalationSequence?: number;
  finalizationKey?: string;
  finalReceipt?: FinnyFinalReceipt;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

`canonicalFinnyPlanDigest` validates the presentation, serializes it with `JSON.stringify`, and hashes it with SHA-256 base64url. Every presentation field is material, object-key ordering is not independently canonicalized, the plan is overwritten on amendment, and no reusable immutable version exists.

The current tool boundary uses `finny(action="create_plan", plan=...)` and `finny(action="amend_plan", jobId=..., plan=...)`. Both accept the exact presentation above plus an optional material clarification. `additionalProperties: false` is already enforced. Approval projections expose the whole presentation as `summaryDetail: JSON.stringify({ plan })`.

#### Current PostgreSQL authority

After migrations `finny/store/0001` through `finny/store/0009`, `finny_jobs` has the following complete shape:

| Column                       | Current type and constraint                                             |
| ---------------------------- | ----------------------------------------------------------------------- |
| `id`                         | `TEXT PRIMARY KEY`                                                      |
| `scope_id`                   | `TEXT NOT NULL CHECK (scope_id <> '')`                                  |
| `plan_presentation`          | `JSONB NOT NULL CHECK (jsonb_typeof(plan_presentation) = 'object')`     |
| `plan_digest`                | `TEXT NOT NULL CHECK (plan_digest <> '')`                               |
| `artifact_digest`            | `TEXT`, empty string rejected, paired with `provisional_revision`       |
| `policy_version`             | `TEXT NOT NULL CHECK (policy_version <> '')`                            |
| `evaluator_ref`              | `JSONB NOT NULL CHECK (jsonb_typeof(evaluator_ref) = 'object')`         |
| `required_generations`       | `JSONB NOT NULL CHECK (jsonb_typeof(required_generations) = 'object')`  |
| `origin_thread_ref`          | `TEXT NOT NULL CHECK (origin_thread_ref <> '')`                         |
| `provisional_revision`       | `TEXT`, empty string rejected, paired with `artifact_digest`            |
| `approval_request_id`        | `TEXT`                                                                  |
| `approval_actor_id`          | `TEXT`                                                                  |
| `approval_action`            | `TEXT CHECK (approval_action IN ('approve','reject','request_change'))` |
| `approval_plan_digest`       | `TEXT`                                                                  |
| `approval_origin_thread_ref` | `TEXT`                                                                  |
| `approval_decided_at`        | `BIGINT`                                                                |
| `approval_consumed_at`       | `BIGINT`                                                                |
| `ledger_head`                | `BIGINT NOT NULL DEFAULT 0 CHECK (ledger_head >= 0)`                    |
| `event_head`                 | `BIGINT NOT NULL DEFAULT 0 CHECK (event_head >= 0)`                     |
| `pending_rework_seq`         | `BIGINT CHECK (pending_rework_seq > 0)`                                 |
| `unresolved_escalation_seq`  | `BIGINT CHECK (unresolved_escalation_seq > 0)`                          |
| `finding_policy`             | `JSONB`, null or a JSON object                                          |
| `finalization_key`           | `TEXT`                                                                  |
| `final_receipt`              | `JSONB`                                                                 |
| `finalized_at`               | `BIGINT`                                                                |
| `created_at`                 | `BIGINT NOT NULL`                                                       |
| `updated_at`                 | `BIGINT NOT NULL`                                                       |

Its indexes and table checks are:

- primary key on `id`;
- unique partial index `finny_jobs_finalization_key` on non-null `finalization_key`;
- index `finny_jobs_scope_created` on `(scope_id, created_at)`;
- `finny_jobs_artifact_binding_pair`, requiring `artifact_digest` and `provisional_revision` to be both null or both present.

`finny_approval_requests` currently has `request_id TEXT PRIMARY KEY`, non-empty `scope_id`, `job_id` referencing `finny_jobs(id) ON DELETE CASCADE`, non-empty `plan_digest`, non-empty `origin_thread_ref`, non-empty `authorized_actor_id`, nullable `ready_at` and `decided_at`, and non-null `created_at`. It has an index on `job_id` and a unique partial index on `job_id` where `decided_at IS NULL`.

`finny_job_events` already owns amendment history. Its `plan_amended` payload contains only `previousPlanDigest` and `newPlanDigest`. `finny_plan_intents.job_input` durably copies `CreateFinnyJobInput`, and `finny_integration_jobs` durably binds the job, current approval request, actor, origin thread, destination, and parent binding. No other current table owns SOP content or job inputs.

#### Proposed TypeScript authority

The proposed validated SOP remains the previously approved minimal contract:

```ts
interface FinnySopVersion {
  schema: "finny.sop.v1";
  id: string;
  version: number;
  scopeId: string;
  title: string;
  intent: {
    domain: "ap" | "ar" | "gl" | "close";
    description: string;
    searchTerms: string[];
  };
  objective: string;
  inputs: Array<{
    id: string;
    label: string;
    from: "human" | "system";
    type: "date" | "text" | "currency" | "entity" | "boolean";
    required: boolean;
    material: boolean;
  }>;
  sources: Array<{
    id: string;
    system: string;
    object: string;
    fields: string[];
    filter: string;
    asOfInput?: string;
  }>;
  steps: Array<{
    id: string;
    action: string;
    reads: string[];
    writes: string;
  }>;
  controls: Array<{
    id: string;
    assertion: string;
    tolerance?: string;
    evidenceRefs: string[];
    judgment?: { question: string; onlyWhen: string };
  }>;
  outputs: Array<{
    id: string;
    kind: "xlsx" | "summary" | "app";
    contract: Record<string, unknown>;
    rerun?: { inputIds: string[] };
  }>;
  approval: { required: true; destination: string };
}

interface FinnyJobSopBinding {
  sopVersionId: string;
  values: Record<string, string | boolean>;
  executionDigest: string;
  revision: number;
}

interface FinnyJob {
  id: string;
  scopeId: string;
  sop: FinnySopVersion;
  sopBinding: FinnyJobSopBinding;
  artifactDigest?: string;
  policy: FinnyPolicySnapshot;
  findingPolicy?: FinnyFindingPolicy;
  originThreadRef: string;
  provisionalRevision?: string;
  approval?: FinnyApproval;
  ledgerHead: number;
  eventHead: number;
  pendingReworkSequence?: number;
  unresolvedEscalationSequence?: number;
  finalizationKey?: string;
  finalReceipt?: FinnyFinalReceipt;
  finalizedAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

`FinnyApproval.planDigest` becomes `executionDigest`. Approval deliberately does not bind `sopRevision`: a non-material value amendment may advance revision provenance without changing the approved execution meaning. A new receipt payload uses `sopVersionId`, `sopRevision`, and `executionDigest` instead of `planDigest`; existing signed receipts remain the legacy union member and are never rewritten. The `plan_amended` event becomes:

```ts
{
  previousSopVersionId: string;
  newSopVersionId: string;
  previousValues: Record<string, string | boolean>;
  newValues: Record<string, string | boolean>;
  previousExecutionDigest: string;
  newExecutionDigest: string;
  revision: number;
}
```

The event is the immutable revision provenance owner. The job row remains the current-state projection. This reuses the existing event ledger instead of adding a second job-revision table.

The tool retains the existing action names to avoid another protocol migration. Its changed inputs are exactly:

```ts
type CreatePlanInput = {
  action: "create_plan";
  sop: FinnySopVersion;
  values: Record<string, string | boolean>;
  materialClarification?: FinnyMaterialClarification;
};

type AmendPlanInput = {
  action: "amend_plan";
  jobId: string;
  sop: FinnySopVersion;
  values: Record<string, string | boolean>;
  materialClarification?: FinnyMaterialClarification;
};
```

`plan` is removed. Core rejects unknown fields, duplicate IDs, missing required values, undeclared values, wrong value types, broken `asOfInput`, `reads`, `evidenceRefs`, and `rerun.inputIds` references, and any workflow-only field such as edges, nodes, nested SOPs, retries, model selection, or prompt authority. Approval projections expose `{ sopVersionId, executionDigest, sop, values }` from the durable row that will execute.

#### Proposed PostgreSQL authority

One new immutable table is added:

```sql
CREATE TABLE finny_sop_versions(
  version_id TEXT PRIMARY KEY CHECK (version_id <> ''),
  scope_id TEXT NOT NULL CHECK (scope_id <> ''),
  sop_id TEXT NOT NULL CHECK (sop_id <> ''),
  version BIGINT NOT NULL CHECK (version > 0),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_digest TEXT NOT NULL CHECK (definition_digest <> ''),
  search_text TEXT NOT NULL CHECK (search_text <> ''),
  created_at BIGINT NOT NULL,
  UNIQUE(scope_id, version_id),
  UNIQUE(scope_id, sop_id, version)
);

CREATE INDEX finny_sop_versions_scope_created
  ON finny_sop_versions(scope_id, created_at DESC);

CREATE INDEX finny_sop_versions_search
  ON finny_sop_versions USING GIN(to_tsvector('simple', search_text));

CREATE FUNCTION reject_finny_sop_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finny SOP versions are immutable';
END;
$$;

CREATE TRIGGER finny_sop_versions_immutable
  BEFORE UPDATE OR DELETE ON finny_sop_versions
  FOR EACH ROW EXECUTE FUNCTION reject_finny_sop_version_mutation();
```

`version_id` is Core-assigned from the canonical scope, SOP ID, and version. `definition_digest` covers the complete canonical version, including display/search metadata. The application exposes no update or delete operation, and PostgreSQL rejects direct mutation. Migration tests prove attempts to update, delete, or replace an existing `(scope_id, sop_id, version)` fail. PostgreSQL foreign keys use `(scope_id, version_id)` so a job cannot bind a version from another organization.

`finny_jobs` retains every lifecycle, policy, artifact, event, and finalization column listed above. Its plan authority changes as follows:

| Current column              | Proposed treatment                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `plan_presentation`         | Retained nullable for finalized legacy history only; always null for SOP jobs and never read as SOP authority |
| `plan_digest`               | Retained nullable for finalized legacy history only; always null for SOP jobs                                 |
| `approval_plan_digest`      | Retained nullable only for historical legacy approvals                                                        |
| `sop_version_id`            | Added `TEXT` and bound with `(scope_id, sop_version_id)` to `finny_sop_versions`                              |
| `bound_inputs`              | Added `JSONB CHECK (bound_inputs IS NULL OR jsonb_typeof(bound_inputs) = 'object')`                           |
| `execution_digest`          | Added `TEXT CHECK (execution_digest IS NULL OR execution_digest <> '')`                                       |
| `sop_revision`              | Added `BIGINT CHECK (sop_revision IS NULL OR sop_revision > 0)`                                               |
| `approval_execution_digest` | Added `TEXT` for the current approval snapshot                                                                |

The exact additive job migration is:

```sql
ALTER TABLE finny_jobs ALTER COLUMN plan_presentation DROP NOT NULL;
ALTER TABLE finny_jobs ALTER COLUMN plan_digest DROP NOT NULL;
ALTER TABLE finny_jobs ADD COLUMN sop_version_id TEXT;
ALTER TABLE finny_jobs ADD COLUMN bound_inputs JSONB;
ALTER TABLE finny_jobs ADD COLUMN execution_digest TEXT;
ALTER TABLE finny_jobs ADD COLUMN sop_revision BIGINT;
ALTER TABLE finny_jobs ADD COLUMN approval_execution_digest TEXT;
ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_sop_scope_fk
  FOREIGN KEY(scope_id, sop_version_id)
  REFERENCES finny_sop_versions(scope_id, version_id);
ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_binding_mode CHECK (
  (
    plan_presentation IS NOT NULL AND plan_digest IS NOT NULL AND
    sop_version_id IS NULL AND bound_inputs IS NULL AND
    execution_digest IS NULL AND sop_revision IS NULL
  ) OR (
    plan_presentation IS NULL AND plan_digest IS NULL AND
    sop_version_id IS NOT NULL AND bound_inputs IS NOT NULL AND
    jsonb_typeof(bound_inputs) = 'object' AND
    execution_digest IS NOT NULL AND execution_digest <> '' AND
    sop_revision IS NOT NULL AND sop_revision > 0
  )
);
ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_approval_binding_mode CHECK (
  NOT (approval_plan_digest IS NOT NULL AND approval_execution_digest IS NOT NULL) AND
  (approval_execution_digest IS NULL OR approval_execution_digest <> '')
);
CREATE INDEX finny_jobs_sop_version
  ON finny_jobs(scope_id, sop_version_id)
  WHERE sop_version_id IS NOT NULL;
```

`finny_jobs_binding_mode` requires exactly one complete binding mode: either the retained legacy `plan_presentation` plus `plan_digest`, or `sop_version_id` plus object `bound_inputs`, non-empty `execution_digest`, and positive `sop_revision`. New writes may use only SOP mode. No runtime path falls back from a missing SOP binding to the legacy presentation. All existing job indexes and constraints remain unchanged.

`finny_approval_requests` retains historical `plan_digest` as nullable and adds non-empty nullable `execution_digest`. Its exact additive migration is:

```sql
ALTER TABLE finny_approval_requests ALTER COLUMN plan_digest DROP NOT NULL;
ALTER TABLE finny_approval_requests ADD COLUMN execution_digest TEXT;
ALTER TABLE finny_approval_requests ADD CONSTRAINT finny_approval_requests_binding_mode CHECK (
  (
    plan_digest IS NOT NULL AND execution_digest IS NULL
  ) OR (
    plan_digest IS NULL AND execution_digest IS NOT NULL AND execution_digest <> ''
  )
);
```

Its existing primary key, foreign key, job index, and one-pending-request partial unique index remain unchanged. New requests use only execution mode. The current job approval snapshot is accepted only when request ID, actor, action, origin, and execution digest match the current job binding. A revision with the same execution digest retains approval; a revision with a different execution digest cannot execute under the prior approval.

No execution-digest uniqueness constraint is added. Two jobs may legitimately execute the same SOP and material inputs, and successive revisions may retain the same digest when only explicitly non-material bound values change. Idempotency remains owned by request IDs and existing idempotency keys, not by the semantic digest.

No setting, environment variable, flag, provider, default, precedence rule, or supported configuration combination changes.

#### Canonicalization and materiality

Core canonicalizes validated objects by schema order and recursively sorted keys inside output contracts. Array order remains material. `definition_digest` hashes the complete canonical SOP version. `execution_digest` hashes only:

- `schema`, SOP ID, version, and scope;
- objective;
- every input declaration and every bound value whose declaration is material;
- complete ordered sources, steps, controls, output contracts, rerun inputs, and approval destination.

Title, intent description, intent search terms, input labels, and bound values explicitly declared non-material are excluded from `execution_digest`. They remain inside the immutable definition or current job binding and appear in receipts. Changing executable content creates a new SOP version. Changing material values creates a new job revision and invalidates approval. Changing only a non-material value creates a provenance event and job revision but preserves the execution digest and approval.

#### Invented before and after rows

These examples are invented and contain no client data.

Before:

```json
{
  "finny_jobs": {
    "id": "job-ap-1",
    "scope_id": "org:invented-media-company",
    "plan_presentation": {
      "title": "AP aging",
      "phases": [{ "name": "Produce", "owner": "Producer", "dependencies": [] }],
      "certification": "Eight checks pass",
      "deliverable": "XLSX and summary",
      "destination": "origin-thread",
      "clarifications": [{ "question": "Cutoff?", "answer": "2026-10-31" }]
    },
    "plan_digest": "legacy-plan-digest",
    "approval_plan_digest": "legacy-plan-digest"
  },
  "finny_approval_requests": {
    "request_id": "approval-ap-1",
    "job_id": "job-ap-1",
    "plan_digest": "legacy-plan-digest"
  }
}
```

After:

```json
{
  "finny_sop_versions": {
    "version_id": "org:invented-media-company/ap-aging@3",
    "scope_id": "org:invented-media-company",
    "sop_id": "ap-aging",
    "version": 3,
    "definition_digest": "full-definition-digest",
    "search_text": "AP aging accounts payable vendor aging MSME cutoff NetSuite transaction vendor"
  },
  "finny_jobs": {
    "id": "job-ap-2",
    "scope_id": "org:invented-media-company",
    "plan_presentation": null,
    "plan_digest": null,
    "sop_version_id": "org:invented-media-company/ap-aging@3",
    "bound_inputs": {
      "cutoff": "2026-10-31",
      "subsidiary": "India Media Pvt Ltd",
      "currency": "INR"
    },
    "execution_digest": "approved-execution-digest",
    "sop_revision": 1,
    "approval_plan_digest": null,
    "approval_execution_digest": "approved-execution-digest"
  },
  "finny_approval_requests": {
    "request_id": "approval-ap-2",
    "job_id": "job-ap-2",
    "plan_digest": null,
    "execution_digest": "approved-execution-digest"
  }
}
```

#### Migration, unfinished jobs, rollout, and rollback

The proposed cutover is intentionally fail-closed:

1. Deploy the additive table, columns, indexes, foreign key, and binding-mode checks while existing code still writes legacy rows.
2. Refuse the behavioral cutover if any legacy job is unfinished, meaning `finalized_at IS NULL`. Operators must let those jobs finish or explicitly cancel them through an approved product path. The migration does not invent AP/AR/GL/close semantics for an old presentation and does not silently close work.
3. Preserve finalized legacy rows, approval requests, events, attestations, and signed receipts unchanged. They remain readable as historical records but are not reusable SOPs.
4. Atomically switch job creation, amendment, approval rendering, Producer compilation, audit compilation, finalization, and recovery to SOP bindings. New writes use only SOP mode.
5. Remove every runtime read of `plan_presentation`, `plan_digest`, and `approval_plan_digest` from active-job paths in the same release. There is no dual-read fallback.
6. Keep the three legacy columns only for historical inspection during the rollback window. A later separately reviewed migration may archive or remove them.

Rollback before step 4 drops only the additive objects. Rollback after step 4 reverts application code while retaining SOP rows and columns; it does not translate SOP jobs into lossy legacy presentations. Therefore application rollback after any SOP job is created requires first disabling new Finny job creation and completing or explicitly cancelling those SOP jobs. Existing finalized records and signed receipts are never rewritten in either direction.

Compatibility effects are explicit: old callers sending `plan` are rejected after cutover; new callers must send `sop` and `values`. Existing finalized history remains readable. Existing unfinished jobs block the cutover instead of entering a mixed authority mode. Producer and audit topology, artifact binding, event sequencing, worker run fencing, and final delivery ownership do not change.

### First baseline fixture decision

The first offline/replay fixture is the invented AP aging task above, expanded into a multi-currency population with partial payments, credits, one unmapped material vendor classification, cutoff-boundary transactions, and a repeatable workbook/mini-app output.

It is selected because one case exercises:

- task-specific SOP creation;
- human-bound cutoff, entity, and currency inputs;
- NetSuite-like source populations and control totals;
- deterministic workbook and summary checks;
- one explicit judgment trigger;
- targeted rework;
- searchable reuse and rerun with changed inputs.

The fixture must be synthetic or de-identified and independently calculated. The user must approve the corpus and accounting gold before it becomes binding. A controlled live NetSuite case is selected only at the Tier 4 corpus-lock checkpoint.

## Phase plan

### Implementation strategy

The first delivery goal is Phase 0 plus Phase 1 only. Phase 0 is the measurement gate for Phase 1; it is not a separate long-running program.

Do not build multiple product phases concurrently and do not move Finny onto QM's swarm subsystem. Parallel agents are used only for independent research, test design, review, and non-overlapping implementation units. One integration owner controls changes to shared orchestration, session, wiring, and Finny runtime files.

Initial parallel lanes:

1. Tool-contract lane: census and replace runtime-facing imaginary Finny tool names with the real `finny(action="...")` contract.
2. Worker-lifecycle lane: design and test Producer-only approval dispatch and artifact-triggered Auditor creation with real first tasks.
3. Evaluation lane: establish the Phase 0 baseline and caller-visible assertions for turns, tokens, timing, artifact, audit, and delivery.

Phase 1 code ownership:

- one integration owner changes `src/finny/runtime-coordinator.ts`, its recovery stores, `src/wiring.ts`, and their focused tests;
- the tool-contract lane may independently change `skills-seed/finnyloop/SKILL.md` only after its caller-visible failing test exists;
- eval work owns the manifest, fixture, and evidence additions and does not change runtime behavior;
- reviewers do not edit implementation files.

The worker-lifecycle slice must include terminal-run recovery. Directly opening a worker with its actionable first task makes that initial run and its admission marker share an identity. Recovery must distinguish missing initial admission from a terminal incomplete run, then create exactly one new granted run for the latter. Shipping lazy worker creation without this correction would weaken existing durability and is not allowed.

Integration order:

1. Land failing caller-visible Phase 0/1 tests and baseline instrumentation.
2. Correct tool vocabulary and delete redundant protocol narration.
3. Change approval to create only the actionable Producer turn.
4. Change artifact readiness to create one actionable Auditor turn.
5. Make failed, stopped, and normally completed-but-incomplete worker runs converge to exactly one next granted run from durable job state.
6. Run affected tests, typecheck, lint, and the offline eval slice.
7. Boot a production-shaped dev instance and verify Slack and QM app behavior with a real model and Postgres.
8. Record measured baseline/candidate time and token results in this document before starting Phase 2.

Phase 2 begins after the Phase 1 PR state is complete. The user authorized SOP implementation and verification on 2026-11-17; persisted schema changes still require the complete before/after review described below to be recorded before code is written.

### Phase 0 — Baseline and completion trace

Status: Complete — paired pre-change and Phase 1 candidate traces captured for both web and Slack

Goal: Establish one measurable end-to-end baseline before changing behavior.

Implementation units:

- Capture queue, model, tool, database, artifact, audit, finalization, and delivery timing for one Slack run and one QM app run.
- Record every Producer/Auditor session and run created for each request.
- Record the durable job state when a run ends without its required transition.
- Add a caller-visible acceptance fixture using a valid representative XLSX and summary contract.
- Classify failures as routing, tool vocabulary, session lifecycle, artifact, audit, completion, or delivery failures.

Exit criteria:

- One reproducible baseline trace exists for Slack and web.
- The test proves failure on the current implementation through the real caller path.
- No production behavior has changed.

### Phase 1 — Remove accidental Pi work

Status: Implemented and verified on both QM web and Slack surfaces

Goal: Eliminate protocol drift and placeholder model turns without changing the trust model.

Implementation units:

- Replace every imaginary Finny tool name with the actual `finny(action="...")` contract.
- Delete duplicated protocol narration from prompts and the seeded Finny skill.
- Open Producer once with the actual approved SOP task.
- Do not open Auditor during approval.
- Open Auditor only after Core commits the immutable artifact.
- Start worker grant expiry when the worker has actionable work.
- Preserve the same parent → Producer → Auditor topology and role isolation.

Exit criteria:

- Exactly one initial Producer turn is created after approval.
- No Auditor turn exists before artifact readiness.
- Every instructed Finny call exists in the actual tool catalog.
- Existing authority, approval, artifact, and audit tests remain green.

### Phase 0/1 live measurement — QM web

The paired production-shaped web runs used the exact same synthetic AP request, real model, durable Postgres, configured spreadsheet evaluator, and visible QM app. `persistent_subagents` was enabled for only the local QA principal before measurement. A preceding diagnostic candidate run is excluded because it included approximately 50 seconds of recovery after that required feature flag was discovered disabled.

Baseline revision: `f2d342f93d7b4dfe157cf5ca831110b565f7603d`
Baseline job: `8c84e1b0-1143-45e2-b713-5e4a613d1b7a`
Candidate job: `f26a8b6e-077b-4632-830d-19193d881d63`
Both results: certified XLSX and summary visibly delivered; all eight checks passed; no rework

| Observation                           | Pre-change baseline | Phase 1 candidate | One-pair change |
| ------------------------------------- | ------------------: | ----------------: | --------------: |
| Query → certified visible delivery    |          192,417 ms |        214,741 ms |          +11.6% |
| Query → human approval                |           39,735 ms |         34,527 ms |          -13.1% |
| Approval → certified visible delivery |          152,682 ms |        180,214 ms |          +18.0% |
| Query → valid artifact                |          112,222 ms |        136,515 ms |          +21.6% |
| Artifact → certified visible delivery |           80,195 ms |         78,226 ms |           -2.5% |
| Producer runs                         |                   2 |                 1 |          -50.0% |
| Auditor runs                          |                   2 |                 1 |          -50.0% |
| Auditor runs before artifact          |                   1 |                 0 |         removed |
| Total provider-reported tokens        |           1,169,154 |           916,153 |          -21.6% |
| Parent tokens                         |             469,784 |           240,395 |          -48.8% |
| Producer tokens                       |             211,722 |           378,200 |          +78.6% |
| Auditor tokens                        |             487,648 |           297,558 |          -39.0% |
| Estimated model cost                  |          USD 1.7172 |        USD 1.6499 |           -3.9% |

Token totals include uncached input, output, cache-read, and cache-write tokens reported for every attributable model request. Both runs were cache-heavy. One pair is evidence of structural turn removal and lower total tokens, but not proof of a latency improvement: the candidate was slower on this pair, and repeated interleaved trials are required to distinguish the code effect from model variance.

The Phase 1 structural gate passed for the candidate: one Producer, no pre-artifact Auditor, one post-artifact Auditor, complete durable usage, finalized receipt, and one visible workbook delivery. The pre-change baseline opened Producer and Auditor together and required two runs for each role. The live trace also proved that run identities and LLM-usage identities differ in production, so the Phase 0 analyzer now accepts explicit durable role attribution instead of assuming one session identifier spans both stores.

### Phase 1 live terminal-run recovery — QM web

Exact revision: `a9abdcc72833`
Web session: `eaacc0da-3140-4874-b958-900880b69cda`
Finny job: `e93afaea-9227-4516-8824-bec0a2e10045`
Producer session: `fe3c43cb-3738-409e-845e-a32b44bdd6c8`

This production-shaped Chrome probe deliberately put a two-turn recovery requirement in the approved plan. The first real Producer run, `407b269f-8972-7718-701d-954d8b7d3887`, finished with run status `done`, result status `ok`, no stop reason, and the exact reply `RECOVERY_PROBE_FIRST_TURN_COMPLETE`. It created no artifact and emitted no Finny job event.

Core derived the incomplete stage from durable state and delivered `producer_retry` 7,973 ms after that run finished. The retry was bound as run `baedd5bd-6426-bec9-b1ad-9b364549221c` in the same Producer session. That run produced and bound artifact `f521effad1966f8f247ec71f301e3c4251a820764b7654daf4715f373c294f2a`; only then did Core open Auditor session `27124c44-6e77-4cc0-9ac2-6963ba1e05b6`.

The independent Auditor recorded all eight required PASS events. The job finalized with event head 45, ledger head 40, and a signed receipt at `1794928652085`. The web surface visibly delivered `AP_Aging_VendorA_20261117.xlsx` once with a certified summary. This is model-dependent fault induction through the public UI, not SQL mutation: every lifecycle transition after approval used the normal Producer, recovery sweep, artifact, Auditor, finalization, and delivery paths.

### Phase 0/1 live measurement — Slack

The exact synthetic request was sent twice to the same `Finny staging` DM in the 11mirror workspace through Chrome: first against the pre-change staging checkout and then against the Phase 1 candidate. Both runs used the same model, approval path, real Postgres state, configured spreadsheet evaluator, and synthetic input. Both visibly attached a certified XLSX and summary with all eight checks passed and no rework.

Baseline revision: `f2d342f93d7b4dfe157cf5ca831110b565f7603d`
Baseline job: `f6f18481-bd8d-4700-8e81-f32193492e7f`
Candidate job: `a64e0f58-c5c7-460a-817d-a766739e8eb7`

| Observation                           | Pre-change baseline | Phase 1 candidate | One-pair change |
| ------------------------------------- | ------------------: | ----------------: | --------------: |
| Query → certified visible delivery    |          255,629 ms |        329,125 ms |          +28.8% |
| Query → valid artifact                |          187,642 ms |        144,926 ms |          -22.8% |
| Artifact → certified visible delivery |           67,987 ms |        144,199 ms |         +112.1% |
| Producer runs                         |                   3 |                 1 |          -66.7% |
| Auditor runs                          |                   4 |                 1 |          -75.0% |
| Auditor runs before artifact          |          at least 1 |                 0 |         removed |
| Total provider-reported tokens        |           1,903,582 |         1,081,287 |          -43.2% |
| Parent tokens                         |             876,287 |           383,077 |          -56.3% |
| Producer tokens                       |             507,412 |           291,697 |          -42.5% |
| Auditor tokens                        |             519,883 |           406,513 |          -21.8% |
| Estimated model cost                  |          USD 3.4252 |        USD 1.7023 |          -50.3% |

The candidate reached a valid artifact 42.7 seconds sooner and removed five of the seven pre-change worker runs, but its final parent continuation and attachment delivery took 76.2 seconds longer after artifact readiness. Overall visible delivery was therefore 73.5 seconds slower on this pair. Together with the web pair, this proves the intended topology and token reduction, but it does not yet prove lower wall-clock latency. Phase 2 planning must treat repeated interleaved web and Slack trials as the latency gate rather than optimizing from either single run.

The Phase 1 Slack structural gate passed: the only Producer began after approval, the only Auditor began 48 ms after the durable `artifact_ready` event, and the certified workbook was visibly attached once. Provider usage was complete for all three roles. No schema or persisted payload shape changed in Phase 0 or Phase 1.

### Phase 2 — Durable SOP creation and execution

Status: Implemented, locally verified, and accepted on the production-shaped QM web surface; Slack acceptance remains pending

Goal: Replace prose-only planning with a surviving, validated SOP contract.

Implementation units:

- Reduce the proposed SOP shape to the smallest finance-specific persisted contract.
- Add structural validation at Finny plan creation.
- Persist the approved SOP or approved SOP revision with the job.
- Render a human-readable SOP approval card from that same durable shape.
- Compile concise role-specific Producer and Auditor instructions from the SOP.
- Keep authoritative live job state in the existing Pi extension projection.
- Add SOP revision provenance and invalidate approval when a material SOP field changes.

Human schema review checkpoint:

- Show the complete old and new `FinnyJob`, plan, database, tool, and API shapes.
- Account for every retained, moved, transformed, added, and dropped field.
- Provide invented before/after examples labelled as invented.
- Explain migration, backfill, rollout, compatibility, and rollback effects.

Exit criteria:

- A process restart or Pi compaction does not lose the approved SOP.
- Producer and Auditor independently read the same SOP version.
- A material amendment cannot run under the previous approval.
- The SOP remains finance-specific and does not become a second workflow engine.

### Phase 1 web clarification decision shape review

This is the complete human-readable review for the caller payload correction required by live Phase 1 QA. It is not the Phase 2 SOP schema.

Old web approval request shape:

```ts
approval?: {
  requestId: string;
  approved: boolean;
  scope?: "once" | "session" | "always";
}
```

New web approval request shape:

```ts
approval?: {
  requestId: string;
  approved: boolean;
  scope?: "once" | "session" | "always";
  optionId?: string;
}
```

`optionId` is required only when approving a `Finny Governance Clarification`. It must equal one option already bound to the durable clarification request. Selecting `Other` sends `approved: false` and records the existing `{ kind: "other" }` Finny clarification decision. Generic approvals and Finny plan approvals do not send `optionId`.

Invented before request:

```json
{ "approval": { "requestId": "generic-approval-1", "approved": true, "scope": "once" } }
```

Invented clarification request after the change:

```json
{
  "approval": {
    "requestId": "generic-approval-1",
    "approved": true,
    "scope": "once",
    "optionId": "month-end"
  }
}
```

Persistence and compatibility effects:

- The approval turn request is already stored durably as part of the run request; `optionId` is added to that existing JSON payload and is not copied into another table.
- The existing `finny_clarification_requests.decision` JSON field already stores `{ kind: "option", optionId }` or `{ kind: "other" }`; its shape, indexes, constraints, and representative rows do not change.
- No database table, column, index, constraint, enum, configuration setting, API route, or response payload changes.
- No migration or backfill is required. Current web code sends an option for every affirmative Finny clarification decision. An affirmative clarification request without `optionId` is rejected instead of guessing the recommendation; there is no dual-read compatibility path.
- Existing pending clarification records remain usable because their durable options are unchanged and the new web renderer reads those options from the current pending approval.

### Phase 3 — Core-owned completion

Status: Not started

Goal: Make durable job state, not a model's final prose or run status, own the next action.

Implementation units:

- On every Finny worker terminal event, derive the next required action from job state.
- Redispatch Producer when approval exists but no valid artifact exists and no Producer work is live.
- Dispatch Auditor when an artifact exists but required audit evidence is incomplete and no Auditor work is live.
- Redispatch targeted Producer rework while a BLOCK remains unresolved.
- Finalize automatically when all current evidence is satisfied.
- Remove recovery logic that guesses completion from run-result text.
- Prefer deriving next work from existing durable state before adding a new queue or status column.

Exit criteria:

- A successful Pi response without `artifact_ready` cannot orphan a job.
- A successful Auditor response without all required verdicts cannot orphan a job.
- Restarting Core converges to the same next action without duplicating work.
- Poison jobs do not block recovery for unrelated jobs.

### Phase 4 — Deterministic audit and targeted rework

Status: Not started

Goal: Verify once, commit once, and return exact repair feedback.

Implementation units:

- Validate artifact identity, MIME type, XLSX container structure, digest, size, and scope eligibility once at binding.
- Run formula, crossfoot, and workbook-structure checks outside Pi.
- Run independent deterministic checks concurrently where policy dependencies permit.
- Finalize without a Pi Auditor call when deterministic controls resolve the full audit.
- Give a Pi Auditor only triggered judgment questions and the immutable deterministic envelope.
- Replace eight independent audit submissions with one atomic audit attempt containing every control verdict and any judgment addendum if the human schema review approves it.
- Preserve check-level verdicts and evidence inside the atomic result.
- On BLOCK, return exact failed checks, affected workbook references, evidence, and required repair to the same Producer session.
- Remove change-kind generation rules that promise evidence reuse when finalization forbids reuse across artifact digests.

Human schema review checkpoint:

- Show old per-check events and the proposed atomic audit payload.
- Show indexes, constraints, event semantics, evidence fields, and representative rows.
- Decide whether old audit rows are migrated, retained read-only, or cut over cleanly.

Exit criteria:

- Artifact bytes and deterministic evidence are read and verified once per audit attempt.
- A revised workbook receives one coherent audit attempt.
- Rework receives only actionable failed-check context.
- Auditor independence and check-level evidence remain inspectable.

### Phase 5 — Certified output and durable delivery

Status: Not started

Goal: Make completion mean the user received a clean workbook and useful certified summary.

Implementation units:

- Persist a typed certified summary produced under the SOP summary contract.
- Validate that the final artifact is a real XLSX before certification.
- Write finalization and delivery intent atomically or through one durable outbox boundary.
- Render Slack and QM app output from the same certified result.
- Deliver workbook, summary, exceptions, caveats, audit status, and receipt together.
- Validate required delivery configuration at startup rather than after finalization.

Human schema review checkpoint:

- Show the complete certified-summary and delivery payload shapes.
- Explain storage, retention, migration, download authorization, and surface compatibility.

Exit criteria:

- A finalized job cannot lack a durable delivery intent.
- The downloaded file passes XLSX structural validation.
- Slack and web show the same certified figures and caveats.
- Delivery retries cannot duplicate the user-visible result.

### Phase 6 — Selective upstream performance adoption

Status: Not started

Goal: Adopt proven generic QM improvements without replacing or weakening Finny.

Candidates, in recommended order:

1. `54cba6b98` and its tests: steer corrections into a running worker.
2. `d5bca76a3`, `ce54d34a5`, `70a834594`: stop, retry, and restart correctness.
3. `61eb435f2`: generic durable session-work and progress projection.
4. `0950fa057`: preserve stored session runtime on resumed turns.
5. `741c843dc`: stable system-prompt snapshots while keeping live Finny authority outside the cached prefix.
6. `6f5fe9bd4`: event-loop lag measurement.

Do not wholesale merge upstream. Do not adopt generic subagent auto-retirement until Finny-owned Producer and Auditor sessions are explicitly persistent or lifecycle-exempt.

Exit criteria:

- Each adapted change has an isolated caller-visible regression test.
- Finny role/run/grant fencing remains intact.
- No live SOP/job authority is frozen into a cached system prompt.
- Progress UI derives from durable runs and sessions rather than a Finny-only parallel state machine.

## Finny High-Performance Eval v1

Status: Design requires user corpus and baseline approval before implementation
Manifest schema: `finny-high-performance-eval.v1`
Result schema: `finny-high-performance-eval-result.v1`

### Existing QM evaluation guidance

QM does not have a general evaluation framework. It currently has:

- ordinary caller-visible Node and Postgres tests;
- the formal offline `evals/finnyloop-r5` manifest/evidence pack;
- production-shaped `dev-instance` QA with real models and Postgres;
- a separate live Slack acceptance harness.

The current r5 pack establishes useful conventions: versioned manifest and result schemas, stable semantic case IDs, explicit invariants, source revision and dirty-state digest, fail-closed execution, `summary.json`, and JUnit output outside Git. It is offline-only, is not a performance methodology, has no versioned finance golden corpus, and is not currently executed as its own CI job.

Repository rules require caller-visible behavioral tests, affected tests plus typecheck/lint, real-model and real-surface QA for nontrivial agent changes, and prod-like evidence that mocks cannot substitute for.

### Eval authority

The eval becomes the executable product contract for this initiative. No phase is complete because its code exists; it is complete when the applicable versioned eval cases pass at the required evidence tier.

Each eval release freezes:

- suite version, case IDs, and case revisions;
- baseline and candidate Git revisions plus complete source-state digests;
- Pi package version, model, provider, runtime, effort, fast mode, and tool-catalog digest;
- Finny policy, evaluator, database schema, and SOP/result schema versions;
- fixture dataset version and digest;
- expected-output/gold digest and connector snapshot digest;
- execution environment, cold/warm/cache state, timestamps, and per-trial order;
- item-log/transcript references, Finny event ledger, artifacts, evidence, result, receipt, and delivery references.

### Evidence tiers

#### Tier 1 — Offline invariants

Runs on every candidate with isolated Postgres and no live services.

It proves:

- authority, approval, role/run, artifact, audit, result, receipt, and delivery invariants;
- SOP schema, execution digest, amendment invalidation, and search scoping;
- deterministic worker and audit-attempt behavior;
- restart/recovery state transitions;
- fail-closed behavior when required dependencies are absent.

The existing `finnyloop-r5` trust cases remain mandatory. The new pack references executable behavior and measured results, not source strings or copied prompt text.

#### Tier 2 — Replay and shadow

Runs real Pi and real Finny tool paths against captured immutable connector inputs without external mutations.

It proves:

- SOP creation from representative finance requests;
- exact source-population and accounting outputs against independently computed gold;
- valid XLSX and certified-result production;
- conditional Pi Auditor invocation;
- artifact/SOP/result search and reuse;
- performance comparisons under identical data.

#### Tier 3 — Production-shaped Slack and QM app

Runs the branch through `dev-instance` with real model, Postgres, configured spreadsheet evaluator, Firefox Slack QA, and the QM web surface.

It proves:

- visible approval and clarification behavior;
- real Producer execution;
- final workbook and summary delivery;
- targeted BLOCK/rework behavior;
- consistent Slack and web results;
- end-to-end latency and token/tool behavior.

#### Tier 4 — Controlled live finance acceptance

Runs only after the user approves the corpus, source credentials, expected populations, equations, and cleanup. It uses a controlled NetSuite/test-source scope and records exact source snapshots or immutable query evidence.

Offline or replay success must never be reported as live finance acceptance.

### Baseline and candidate protocol

1. Run baseline and candidate from clean isolated databases and artifact namespaces against identical immutable fixtures.
2. Interleave trial order so provider drift, cache warmth, and time of day do not consistently favor one revision.
3. Hold model, effort, tools, credentials, connector snapshot, evaluator, and Pi package fixed unless one is the declared evaluated factor.
4. Label cold starts and warm/cache-hit observations by observed environment state rather than an invented warm-up count.
5. Record first-attempt failure and partial artifacts. Recovery is a separate measurement; failed trials are never invisibly retried.
6. Repeat paired trials until the uncertainty is narrow enough for the user to decide. The stopping rule uses observed variance and confidence-interval width, not an arbitrary fixed sample count.

### Versioned finance corpus

The repository currently lacks a versioned finance golden corpus. Finny High-Performance Eval v1 must add a synthetic or de-identified, organization-neutral corpus whose version and digest are recorded in every result.

Initial task families:

- AP aging and outstanding liability;
- AR aging, receipts, unapplied cash, and overdue analysis;
- GL account reconciliation and trial-balance tie-out;
- close/cutoff support;
- cash and bank reconciliation;
- management reporting with workbook, certified summary, and optional rerunnable mini app.

Each case defines:

- request and bound inputs;
- approved SOP or required SOP properties;
- source-of-truth fixture and population membership;
- independently computed expected figures and accounting equations;
- required workbook structure, formulas, values, and lineage;
- required certified-summary facts and detail references;
- expected clarification, PASS, BLOCK, or refusal;
- applicable evidence tier.

### Edge-case matrix

The initial corpus must cover:

- multi-currency totals, conversion, and prohibited netting;
- credits, reversals, refunds, partial payments, partial receipts, and unapplied cash;
- duplicate transactions, duplicate external IDs, and amended source rows;
- cutoff boundaries, timezone/day-end, closed or reopened periods, and late postings;
- subsidiary, book, entity, and intercompany boundaries;
- tax, withholding, MSME, rounding, materiality, zero, and negative balances;
- missing joins or fields, incomplete populations, pagination gaps, and stale connector snapshots;
- formula errors, cached-value mismatch, hidden sheets or rows, merged cells, corrupt XLSX, and unsupported workbook constructs;
- source-lineage mismatch, artifact replacement, stale evidence, and evaluator change;
- missing material parameters requiring clarification rather than guessed execution;
- exact repeat, near repeat with changed cutoff/entity/currency, and stale prior-result reuse;
- repeatable report or mini app with identical-input reproducibility and changed-input refresh;
- process death at every durable boundary;
- wrong actor/thread, copied approval, replayed/concurrent approval, amendment after approval, and escalation.

Numeric tolerances come from source precision, currency minor units, accounting equations, or an approved materiality policy. The eval must not invent a universal tolerance.

### Correctness and determinism gates

Hard invariants are not scores. Any failure blocks the candidate:

- correct source population and accounting figures;
- valid approval and exact execution digest;
- correct role/run and artifact authority;
- no certified delivery before required audit completion;
- valid XLSX bound to its digest and receipt;
- deterministic controls produce identical canonical results on identical inputs;
- no stale or unapproved artifact/evidence reuse;
- restart yields one logical job, monotonic events, and exact-once delivery.

Canonical comparisons cover:

- event sequence modulo declared volatile IDs and timestamps;
- SOP execution digest, source snapshot digest, artifact digest, audit-envelope digest, result digest, and receipt payload;
- workbook sheet contract, values, formulas, styles, and named ranges after removing declared volatile metadata;
- mini-app data/schema and semantic DOM after removing declared volatile fields;
- summary facts and detail references as a set, while wording variance is measured separately.

### Conditional judgment eval

Cases must prove both branches:

- every objective control passes and no judgment trigger exists → no Pi Auditor turn is created;
- a declared judgment predicate triggers → exactly one bounded Pi Auditor task receives the immutable deterministic envelope and returns a structured addendum;
- deterministic failure → no LLM may override the failed control;
- uncertain judgment → CLARIFY or BLOCK, never fabricated certainty;
- the same input produces stable trigger/no-trigger behavior.

### Search, summary, and reuse eval

Use longitudinal sequences:

1. Complete and certify a report.
2. Ask for the exact report again.
3. Ask for a near-repeat with a changed cutoff, entity, or currency.
4. Ask to find the last approved report and explain what changed.
5. Ask to reuse the prior layout while refreshing source data.
6. Amend the source and prove that stale artifacts remain searchable but cannot become current evidence.

Measure retrieval precision and recall against a gold eligible-SOP/result set. A faster stale, wrong-scope, unapproved, or lineage-incompatible reuse is a hard failure.

### Performance observations

Two primary end-to-end performance metrics apply to every successful query:

- `query_to_certified_delivery_ms`: elapsed system time from QM accepting the user's query until the certified answer, workbook, audit result, and receipt are visible to the user. Report human clarification and approval waiting separately so the complete elapsed time and the system-controlled time are both visible. The measurement includes SOP creation, Producer work, deterministic audit, any Pi Auditor judgment, finalization, and delivery.
- `total_query_tokens`: total input, output, reasoning, and cached tokens consumed by every model call attributable to the query across the parent/coordinator, Producer, and any Pi Auditor turn. Report the total first, then the role and phase breakdown. A deterministic audit that correctly avoids a Pi Auditor call records zero Auditor tokens rather than omitting the role.

Baseline and candidate reports must compare these two metrics directly for each case and as paired distributions across the suite. A faster answer that excludes audit time or a lower token count that excludes a child-agent turn is invalid evidence.

Track paired distributions for:

- total query-to-certified-delivery time, including the complete audit path;
- total query tokens across parent, Producer, and any Pi Auditor;
- request → SOP/clarification/approval-ready;
- approval → Producer start;
- Producer start → valid artifact;
- artifact → deterministic audit result;
- judgment trigger → Pi Auditor result;
- BLOCK → same-session Producer correction;
- final audit → visible Slack/web delivery;
- total end-to-end time separated into system wait and human wait;
- parent, Producer, and Auditor Pi turns;
- model/tool calls, failed/repeated calls, tokens, cache behavior, and estimated cost;
- connector pages/rows, artifact reads/hashes, database round trips, rework attempts, and recovery duration;
- orphaned or falsely completed jobs.

Performance targets are not invented upfront. Establish baseline median, tail, and run-to-run noise from paired measurements. A candidate wins only when improvement exceeds the measured repeatability band while every hard invariant remains green. A demonstrated regression beyond that band fails. Overlapping uncertainty is reported as inconclusive.

Cold/warm and cache-hit/miss observations remain separate. A single blended latency number is not acceptable.

### Eval scorecard

Use a lexicographic scorecard, never one weighted aggregate:

1. Hard invariants: absolute pass/fail.
2. Task outcomes: correctness, required clarification, true/false BLOCK, complete delivery by task family.
3. Determinism: exact canonical fields plus semantic stability distribution.
4. Efficiency: paired end-to-end query time including audit, total tokens across all roles, turns, cost, connector work, artifact work, and rework.
5. Human quality: blinded factual defects, usefulness, and presentation preference for summary/workbook/mini app.

### User review gates

The eval must check with the user at these points:

1. Corpus lock: approve task families, fixture sources, edge cases, and client-safety constraints.
2. Accounting gold lock: approve expected populations, equations, cutoff/currency/entity rules, tolerances, and materiality.
3. Baseline review: inspect current failures and measured variance before candidate targets become binding.
4. Blind output review: compare baseline and candidate workbook, summary, and mini app without labels.
5. Tradeoff gate: decide any speed, cost, and output-quality tradeoff; the eval reports the Pareto comparison and does not invent weights.
6. Release sign-off: review hard invariants, paired performance uncertainty, unresolved cases, restart evidence, and representative artifacts.

Known baseline defects must not silently become expected gold. The user decides whether each is a release blocker or tracked debt.

### Eval outputs

Write outside the source tree:

- manifest and environment fingerprints;
- baseline, candidate, and paired-comparison JSON;
- per-case/trial events, metrics, transcript references, and artifact/evidence/result/receipt metadata;
- JUnit for invariant gates;
- a reproducible HTML report with case filters, phase waterfalls, turns/tools/tokens, ledger timeline, artifact comparison, restart point, and blinded-review results.

The HTML report is derived from JSON evidence. Regenerating it from identical evidence must produce the same semantic output.

### CI and live-gate plan

- Keep `finnyloop-r5` as the existing trust/invariant pack.
- Add a sibling high-performance eval pack rather than changing the r5 schema.
- Add a manifest meta-test verifying schema, unique IDs, corpus version/digest, evidence-tier separation, executable evidence, package script, and fail-closed output.
- Add a CI job for `npm run eval:finnyloop-r5` with Postgres and upload its JSON/JUnit evidence.
- Add the offline high-performance pack as an initially observational CI job.
- Make performance comparisons gating only after the user approves corpus, gold, baseline, and measured repeatability.
- Use `dev-instance` and the live Slack/QM app paths for production-shaped acceptance; restore or replace the currently missing live-e2e workflow before claiming automated live acceptance.

Each implementation phase still runs affected tests, typecheck, and lint locally. CI remains the full-suite gate.

## Non-goals

- A separate `finny-staging` deployment or Slack bot architecture.
- Moving Finny onto QM swarms.
- Importing LoopForge's workflow engine.
- Building a generic SOP platform for all QM work.
- Weakening independent audit, artifact provenance, approval binding, or durable evidence.
- Preserving compatibility layers for abandoned Finny protocol shapes without explicit human approval.

## Decision log

### 2026-11-17 — Preserve current Finny topology

Decision: Keep QM parent → Producer → independent audit stage. Producer work executes through Pi. The audit stage is always independent, but it creates a Pi Auditor child only when an explicit judgment predicate requires model judgment.

Reason: The topology is sound, but spending an LLM call on already-resolved arithmetic and structural controls is unnecessary. The observed failures come from protocol drift, placeholder turns, fragmented audit commits, incomplete completion ownership, and weak final output contracts.

### 2026-11-17 — Borrow LoopForge discipline, not its engine

Decision: Introduce a durable finance-specific SOP contract compiled into role instructions and deterministic checks. Do not import LoopForge nodes, DAG runtime, nested SOP engine, or retry-budget framework.

Reason: QM already owns the required durable primitives. A second workflow engine would duplicate authority and contradict QM's thin-harness and delete-before-add principles.

### 2026-11-17 — No blanket upstream sync

Decision: Adapt selected upstream improvements individually with Finny regression tests.

Reason: Downstream and upstream have diverged substantially, and upstream does not contain the Finny subsystem.

### 2026-11-17 — Approval binds execution, not search labels

Decision: One canonical execution digest covers objective, material inputs, sources, ordered steps, controls, outputs, rerun parameters, and approval destination. Display title and search metadata do not invalidate approval.

Reason: Approval must change when execution meaning changes without turning harmless search-label edits into a new finance decision.

### 2026-11-17 — One atomic audit attempt

Decision: One artifact produces one immutable audit envelope containing all deterministic control verdicts and an optional Pi Auditor judgment addendum. Finalization consumes the completed attempt rather than eight independently submitted model-driven attestations.

Reason: It verifies the artifact once, makes completion explicit, preserves check-level evidence, and removes repeated calls and contradictory generation semantics.

### 2026-11-17 — Dedicated certified result record

Decision: Store the complete certified summary in one `finny_results` owner referenced by `finny_jobs`, with stable references to the SOP, artifact, evidence, workbook cells, mini-app views, and delivery.

Reason: Agents need a short searchable summary without copying detailed evidence into job rows or prompts.

### 2026-11-17 — Eval governs implementation

Decision: Add a sibling versioned Finny High-Performance Eval pack, retain r5 trust invariants, and require user approval of corpus, accounting gold, baseline, and final tradeoffs before performance results become release gates.

Reason: Current QM has useful offline evidence conventions but no versioned finance corpus, production-shaped performance methodology, or approved quality baseline.

## Running implementation log

| Date       |    Phase | Change                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                  | Status                                                        | Owner             |
| ---------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| 2026-11-17 | Research | Audited current Finny lifecycle, latest upstream QM, Pi harness, and LoopForge                                                                                                                                                                      | Source review at downstream `f2d342f9`, upstream `b3ba0524`, LoopForge `86b0ee06`                                                                                                                                                                                                                                                         | Complete                                                      | Research agents   |
| 2026-11-17 | Planning | Established phased high-performance SOP harness plan                                                                                                                                                                                                | This document                                                                                                                                                                                                                                                                                                                             | Complete                                                      | Primary agent     |
| 2026-11-17 | Planning | Resolved SOP, approval, audit, result, baseline-fixture, and evaluation design decisions                                                                                                                                                            | This document and current QM eval audit                                                                                                                                                                                                                                                                                                   | Complete pending human schema/corpus review                   | Primary agent     |
| 2026-11-17 |  Phase 0 | Added a production-independent baseline analyzer for Producer/Auditor run counts, pre-artifact Auditor detection, query-to-certified-delivery time, and parent/Producer/Auditor tokens with fail-closed missing usage                               | [Analyzer and tests](#phase-0--baseline-and-completion-trace); paired web and Slack measurements are linked in the implementation summary                                                                                                                                                                                                 | Complete                                                      | Evaluation lane   |
| 2026-11-17 |  Phase 1 | Corrected Finny tool vocabulary, removed placeholder dispatch turns, opened Producer only after approval with its real task, opened Auditor only after artifact commit, and recovered terminal successful-but-incomplete workers from durable state | [Web evidence](#phase-01-live-measurement--qm-web): one Producer, one post-artifact Auditor, certified XLSX, 21.6% fewer tokens. [Slack evidence](#phase-01-live-measurement--slack): one Producer, one post-artifact Auditor, certified attached XLSX, 43.2% fewer tokens.                                                               | Complete on web and Slack; latency improvement not yet proven | Integration owner |
| 2026-11-17 |  Phase 1 | Preserved the durable Finny plan request identity across the generic web approval boundary after live QA exposed a false-success dispatch                                                                                                           | RED: web Finny tool test observed no durable `finny-plan:<requestId>` approval key. GREEN: the tool retains the request identity; the orchestrator decides that Finny request; the live Producer opened immediately after approval.                                                                                                       | Complete                                                      | Integration owner |
| 2026-11-17 |  Phase 1 | Closed the material-clarification handoff so every persisted option and `Other` is actionable, the exact ready plan is projected immediately, and Finny translation stays outside the generic orchestrator                                          | RED: caller-visible Postgres tests proved the prior code ignored alternate options, treated `Other` as command denial, and returned no next approval. GREEN: affected core/web suites, typecheck, and oxlint pass. Chrome shows all options and `Other`; selecting a nonrecommended date records that exact choice and requires revision. | Complete                                                      | Integration owner |
| 2026-11-17 |  Phase 1 | Exercised the `Other` clarification path against the running production-shaped web instance in Chrome                                                                                                                                               | Session `762bf470-2392-4f1e-8456-1446297f9c5a`: `Other` consumed the durable Finny clarification and returned `Revision is required before this plan can be approved. Submit a revised plan to continue.` The composer reopened for the revised input.                                                                                    | Complete                                                      | Production QA     |
| 2026-11-17 |  Phase 1 | Closed both clarification commit-to-projection crash windows without adding another recovery queue                                                                                                                                                  | RED: a committed clarification replay returned no usable result, and an injected plan-projection failure could delete the clarification approval before its replacement existed. GREEN: the service reconstructs the durable result idempotently and the orchestrator persists the replacement before deleting its predecessor.           | Complete; no schema or configuration change                   | Integration owner |
| 2026-11-17 |  Phase 1 | Proved terminal successful-but-incomplete Producer recovery through the exact-head production-shaped web surface                                                                                                                                    | [Live terminal-run recovery](#phase-1-live-terminal-run-recovery--qm-web): first run `done`/`ok` with no artifact; durable `producer_retry` bound a new run in the same session; artifact, independent eight-check audit, receipt, workbook, and certified summary followed.                                                              | Complete                                                      | Production QA     |
| 2026-11-17 |  Phase 1 | Bound clarification replay to its exact durable Finny job instead of the newest pending approval in the Slack or web thread                                                                                                                         | RED: a two-job Postgres regression reproduced clarification A displaying newer plan B. GREEN: replay resolves readiness and the replacement approval by `scope_id` plus `job_id`; affected approval, web, and store tests pass.                                                                                                           | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Made every persisted clarification option actionable without another human turn                                                                                                                                                                     | RED: a nonrecommended option ended with an instruction to repeat the choice. GREEN: the parent resumes with the exact recorded option, amends the existing job, withdraws the stale approval, and projects the durable replacement plan approval; `Other` still opens free-form revision.                                                 | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Bound automatic worker recovery to the terminal run observed by the durable scan                                                                                                                                                                    | RED: replaying one stale Producer or Auditor recovery snapshot dispatched twice and could replace healthy work. GREEN: recovery carries the observed run ID and dispatches only while the active binding still matches it; the existing compare-and-swap advances the binding atomically.                                                 | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Excluded human-wait and refused terminal outcomes from automatic Producer and Auditor recovery                                                                                                                                                      | RED: `done` runs returning `pending_approval` or `refused` were eligible for restart. GREEN: the durable recovery census distinguishes those outcomes from missing, failed, expired-live, and successful-but-incomplete work, with regressions for both roles.                                                                            | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Preserved the real actor and integration-parent request binding across an alternate-choice plan amendment                                                                                                                                           | RED: the replacement approval used a fallback actor and the original parent request ID, so approval could claim success without Producer dispatch. GREEN: amendment updates both bindings atomically; a non-default actor approves the replacement and opens one Producer for the same job.                                               | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Applied the durable run-outcome census to fresh Auditor reverification admission                                                                                                                                                                    | RED: a fresh reverification Auditor waiting on approval was selected for another wake because no delivery marker existed. GREEN: active run state preserves `pending_approval` and `refused` work even after binding expiry while retaining recovery for missing, failed, expired-live, and incomplete runs.                              | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Moved guarded admission validation ahead of worker interruption inside the shared session admission lock                                                                                                                                            | RED: a stale Finny dispatch could stop a healthy replacement before its compare-and-swap rejected the write. GREEN: `beforeEnqueue` runs under the admission lock before `stopSessionRuns`; a rejected guarded interrupt leaves the active run healthy.                                                                                   | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 1 | Verified the complete alternate-choice flow on the exact-head production-shaped web instance in Chrome                                                                                                                                              | Session `fa96216e-87a4-4ca9-b2ed-c54b1aa74263`: the user selected `2026-11-30`; QM resumed the same parent without another human message, presented a replacement plan explicitly bound to the alternate cutoff, accepted approval, and visibly started one Producer subagent.                                                            | Complete                                                      | Production QA     |
| 2026-11-17 |  Phase 1 | Bound reverification recovery to the exact Auditor run observed by the durable scan                                                                                                                                                                 | RED: replaying one orphaned, terminal, or expired reverification recovery could target a replacement or stall on an expired binding. GREEN: active bindings retry in the same session with an observed-run guard; missing bindings admit once; stale replay is ignored; the obsolete delivery-prefix lookup is removed.                   | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |  Phase 2 | User authorized task-level SOP implementation and verification as the next milestone after the Phase 1 PR is complete                                                                                                                               | This document remains the working contract; first record the complete human-readable old/new schema and migration review, then implement one finance-specific SOP persistence and execution slice.                                                                                                                                        | Queued                                                        | Integration owner |
| 2026-11-18 |  Phase 2 | Added the durable next-session implementation handover                                                                                                                                                                                              | [Handover](./2026-11-18-finny-sop-phase-2-handover.md) links the authoritative design, exact schema gate, TDD sequence, live/eval measurements, guardrails, and definition of done.                                                                                                                                                       | Ready after Phase 1 PR completion                             | Integration owner |
| 2026-11-18 |  Phase 2 | Recorded the complete old/new SOP and job schema review before implementation                                                                                                                                                                       | [Phase 2 SOP and job schema gate](#phase-2-sop-and-job-schema-gate) covers TypeScript, tool/API, PostgreSQL, field accounting, invented rows, canonicalization, migration, unfinished jobs, rollout, rollback, compatibility, and unchanged configuration.                                                                                | Awaiting human review; no persisted-shape code written        | Integration owner |
| 2026-11-18 |  Phase 2 | Implemented immutable `finny.sop.v1` authority and cut active execution over to exact SOP bindings                                                                                                                                                  | Commits `cace9f55a` through `1857c698a`; approval binds the execution digest, material amendments invalidate approval with provenance, Producer and Auditor compile from the same version, and unfinished legacy jobs fail migration while finalized legacy history remains readable.                                                    | Complete; approved schema live only in isolated QA PostgreSQL | Integration owner |
| 2026-11-18 |  Phase 2 | Verified the affected implementation and clarified the artifact binding exposed by live acceptance                                                                                                                                                 | All 27 `test/finny*.test.ts` files pass, focused agent-tool tests pass, typecheck and FinnyLoop r5 pass, and changed implementation paths pass ESLint. Repository-wide ESLint still reports two unchanged baseline errors in `plugins/web-ui/src/generative-card.ts` and `src/slack/generative-ui.ts`.                                  | Complete                                                      | Integration owner |
| 2026-11-18 |  Phase 2 | Completed a real-model AP-aging approval, production, deterministic audit, targeted rework, certification, and delivery in Firefox                                                                                                                  | Web session `3a3fbec7-0d78-47d5-b22e-b726abe12af5`, job `b424e17b-9bba-459d-90df-001603898d51`, SOP `personal%3Akalicharanshukla/sop.ap.aging.inr@1`. The first artifact was blocked on `summary.crossfoot`; the replacement passed events 6–13 and delivered digest `0aa5b159…0eac7ec0`. | Complete; diagnostic run, not a performance baseline          | Production QA     |
| 2026-11-18 |  Phase 2 | Recorded diagnostic timing and model usage for the accepted web run                                                                                                                                                                                 | Job creation to finalization was 11m58s; approval to finalization was 11m14s; first artifact to finalization was 4m14s; replacement artifact to finalization was 2m15s. Parent, Producer, and two Auditor sessions used 250 uncached input, 71,996 output, 5,701,677 cache-read, and 540,443 cache-write tokens.                         | Complete; includes QA recovery and is not an SLA comparison   | Production QA     |
| 2026-11-18 |  Phase 2 | Kept later authority gates closed                                                                                                                                                                                                                    | No `finny_audit_attempts` or `finny_results` schema was added. No repository configuration changed; `persistent_subagents` was enabled only in the isolated QA database to exercise the configured dev instance. The synthetic corpus and independent accounting gold remain unapproved.                                              | Complete                                                      | Integration owner |

## Required human decisions for Phase 2 gates

1. SOP implementation is authorized. Before the persisted change is written, record and review the complete old/new SOP and job shapes, indexes, constraints, representative rows, migration, backfill, rollout, and compatibility effects. Audit-attempt and certified-result schema changes remain later gates.
2. Approve the synthetic/de-identified AP aging corpus and independently calculated accounting gold.
3. Approve which controlled NetSuite/test-source population may be used for Tier 4 live acceptance.
4. Review the measured baseline and decide which existing defects are release blockers versus tracked debt.
5. Approve any product SLA used as an absolute performance target; otherwise the eval uses paired baseline variance.
