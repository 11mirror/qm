# Finny High-Performance SOP Harness

Status: Active design and implementation tracker
Created: 2026-11-17
Last updated: 2026-11-18
Owner: Finny/QM working agents
Implementation state: Phases 0–2 are merged; Phase 3 removes non-Core recovery fallbacks and is verified through production-shaped Slack crash recovery, certification, and single delivery
Landed branch: `main`
Working tree: `/Users/kalicharanshukla/.codex/worktrees/finny-architecture-audit/QM`
Phase 0/1 implementation commit: `4e0fbbbb9`
Phase 1 merge: [11mirror/qm#34](https://github.com/11mirror/qm/pull/34), `7d40666e7`
Phase 2 merge: [11mirror/qm#35](https://github.com/11mirror/qm/pull/35), `897066570`

## Implementation summary

This table is the quick handoff. Follow the links for design, implementation, and measured evidence.

| Area                  | Done                                                                                                                                                                                                                                    | Where and evidence                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research              | Audited downstream Finny, current upstream QM, Pi execution, and LoopForge SOP patterns                                                                                                                                                 | [Evidence baseline](#evidence-baseline) and [architectural position](#architectural-position)                                                                                                                             |
| Phase 0               | Added fail-closed measurement of worker turns, pre-artifact Auditor starts, certified-delivery time, and per-role tokens                                                                                                                | [Analyzer](../../evals/finny-high-performance-v1/baseline.mts), [tests](../../test/finny-phase0-baseline.test.ts), and [eval design](#finny-high-performance-eval-v1)                                                     |
| Tool contract         | Replaced imaginary standalone Finny tools with the real `finny(action="...")` contract                                                                                                                                                  | [Finny tool](../../src/agent/agent-tools/finny.ts), [seed skill](../../skills-seed/finnyloop/SKILL.md), and [Phase 1 details](#phase-1--remove-accidental-pi-work)                                                        |
| Worker lifecycle      | Approval now starts one actionable Producer; artifact commit starts one actionable Auditor                                                                                                                                              | [Runtime coordinator](../../src/finny/runtime-coordinator.ts), [runtime store](../../src/finny/runtime-postgres-store.ts), and [lifecycle tests](../../test/finny-runtime-coordinator.test.ts)                            |
| Durable recovery      | Successful-but-incomplete terminal worker runs are reconciled from durable job state without placeholder turns                                                                                                                          | [Integration](../../src/finny/integration.ts), [integration store](../../src/finny/integration-postgres-store.ts), and [recovery tests](../../test/finny-integration-runtime.test.ts)                                     |
| Web approval          | Preserved the durable Finny request identity and projects the ready plan immediately after a material clarification                                                                                                                     | [Orchestrator](../../src/core/orchestrator.ts), [approval service](../../src/finny/approval-service.ts), [regression test](../../test/finny-web-approval.test.ts), and [web evidence](#phase-01-live-measurement--qm-web) |
| Live web result       | Certified XLSX delivered with one Producer and one post-artifact Auditor; total tokens fell 21.6% in the paired run                                                                                                                     | [Web baseline and candidate](#phase-01-live-measurement--qm-web)                                                                                                                                                          |
| Live Slack result     | Certified XLSX attached in the 11mirror `finny-staging` DM with one Producer and one post-artifact Auditor; total tokens fell 43.2%                                                                                                     | [Slack baseline and candidate](#phase-01-live-measurement--slack)                                                                                                                                                         |
| Verification          | Phase 1 focused suites, typecheck, ESLint/oxlint, FinnyLoop r5, and real Chrome web plus Slack QA pass                                                                                                                                  | [Running implementation log](#running-implementation-log) and [r5 manifest](../../evals/finnyloop-r5/manifest.json)                                                                                                       |
| Schema/config         | No database schema, persisted payload, or configuration change in Phase 0/1                                                                                                                                                             | [Phase 0/1 evidence](#phase-01-live-measurement--qm-web)                                                                                                                                                                  |
| Phase 2               | Immutable SOP authority, exact execution-digest approval, material and non-material amendments, role-specific compilation, default-paged search, action-filtered recovery, and web/Slack acceptance are merged                          | [Phase 2](#phase-2--durable-sop-creation-and-execution), [schema gate](#phase-2-sop-and-job-schema-gate), [PR #35](https://github.com/11mirror/qm/pull/35), and [running log](#running-implementation-log)                |
| Current phase         | Phase 4/5 implementation complete on the branch: atomic audit attempts, targeted rework, typed certified results, and result-owned durable delivery are implemented and locally verified. Phase 3 Core-owned recovery remains complete. | [Phase 4/5 schema gate](#phase-45-audit-result-and-delivery-schema-gate)                                                                                                                                                  |
| Next gates            | Independent review and CI remain before merge. The corpus/gold, controlled source population, and any SLA remain behind separate human approvals.                                                                                       | [Phase 4/5 schema gate](#phase-45-audit-result-and-delivery-schema-gate), [later phases](#phase-4--deterministic-audit-and-targeted-rework), and [human decisions](#required-human-decisions-for-later-gates)             |
| Next-session handover | Resolve review or CI findings, complete Slack QA when a second Slack pool app is available, and land through the merge queue. Keep the existing Sharechat/personal pool3 instance isolated.                                             | [Phase 4/5 schema gate](#phase-45-audit-result-and-delivery-schema-gate)                                                                                                                                                  |

## How to use this document

This is the running implementation artifact for restoring Finny performance while preserving the existing QM parent → Producer → Auditor architecture.

Every agent working on this initiative must:

1. Read `docs/SPEC.md`, `CODING_STANDARDS.md`, `REVIEW.md`, and this document before changing code.
2. Work on only one phase or explicitly named implementation unit at a time.
3. Update the implementation summary plus the detailed phase status, evidence, decisions, verification results, and open risks before handing work off.
4. Distinguish proposed design, implemented code, locally verified behavior, and deployed behavior.
5. Keep the current Finny topology. The separate `finny-staging` deployment proposal is outside this initiative.
6. Prefer deleting protocol and redundant state over adding another workflow layer.
7. For the next implementation session, follow the [Phase 3 core-owned completion handover](./2026-11-18-finny-phase-3-handover.md) and keep this document updated as the running source of truth.

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

Status: Approved by the user on 2026-11-18 and merged in [PR #35](https://github.com/11mirror/qm/pull/35) as `897066570`. The schema was exercised in isolated development acceptance databases; production deployment is not claimed.

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

Status: Complete and merged in [PR #35](https://github.com/11mirror/qm/pull/35) as `897066570`; verified on production-shaped QM web and Slack

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

Achieved:

- Core validates and persists immutable `finny.sop.v1` versions and binds each active job to one exact version, bound-input set, execution digest, and positive revision.
- Active approval, Producer, Auditor, receipt, recovery, and delivery paths use execution-digest authority; finalized legacy rows remain read-only history behind permanent cutover checks.
- Material amendments fail closed outside the bound origin, replace approval atomically, and cannot execute until the new digest is approved. Non-material value amendments advance provenance while retaining the approved digest.
- Parent turns retain the strict SOP authoring contract; Producer and Auditor turns omit that schema and receive only their role-specific execution actions.
- SOP search pages ranked IDs before loading definitions. Final recovery selects only missing or retryable-expired deliveries and jobs whose parent or active worker bindings still need retirement.
- The affected 27-file PostgreSQL suite, typecheck, changed-path ESLint, FinnyLoop r5, independent reviews, a complete Slack BLOCK/rework/certification flow, and both amendment paths passed on the final head.

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

Status: Complete on the implementation head. The completion-path census, removal of non-Core recovery fallbacks, focused verification, backlog measurement, and production-shaped Slack recovery acceptance are complete. The later Phase 4/5 schema gate is now authorized separately below.

Goal: Make durable job state, not a model's final prose or run status, own the next action.

Implementation units:

- On every Finny worker terminal event, derive the next required action from job state.
- Redispatch Producer when approval exists but no valid artifact exists and no Producer work is live.
- Dispatch Auditor when an artifact exists but required audit evidence is incomplete and no Auditor work is live.
- Redispatch targeted Producer rework while a BLOCK remains unresolved.
- Finalize automatically when all current evidence is satisfied.
- Remove recovery logic that guesses completion from run-result text.
- Prefer deriving next work from existing durable state before adding a new queue or status column.

Already available from Phases 1–2:

- approval admits one Producer; artifact authority admits one Auditor;
- terminal successful-but-incomplete Producer and Auditor work is redispatched from durable job state;
- human-wait and refused outcomes are excluded from automatic redispatch;
- recovery is fenced to the exact observed run and survives restart;
- final-delivery recovery is filtered to actionable delivery and binding-cleanup state.

Next work:

1. Census every Producer and Auditor terminal outcome, finalization boundary, restart scan, and delivery handoff; identify any branch that still infers completion from model prose or generic run-result text.
2. Add caller-visible failing tests only for confirmed gaps: successful runs without the required Finny transition, Core death at each commit/dispatch boundary, duplicate recovery scans, and poison-job isolation.
3. Consolidate each confirmed gap into the existing job-state reconciliation path and delete superseded result-text or delivery-prefix guesses.
4. Measure reconciliation with a representative recovery backlog so serial scans and unbounded actionable result sets are visible before claiming the phase is performant.
5. Re-run the affected Finny suites, FinnyLoop r5, and production-shaped web/Slack recovery acceptance. Record timings and token usage as diagnostic evidence, not an SLA claim.

Do not add `finny_audit_attempts`, `finny_results`, another queue, or a parallel workflow state machine in Phase 3. Those belong to later human gates.

#### 2026-11-18 completion-path census and evidence

- Producer terminal recovery flows through `finny_integration_jobs` plus durable job approval/artifact state. Delivered BLOCK rework is also recovered when the observed Producer terminates without replacing the artifact. Both paths distinguish live or human-wait/refused work from successful-but-incomplete work through typed run outcomes; no model reply text is inspected.
- Auditor admission, terminal retry, rework, and reverification flow through `finny_runtime_actions`, `finny_runtime_bindings`, `finny_runtime_dispatches`, and current job evidence. Crash tests cover authority committed before artifact, PASS, BLOCK, and escalation events. Rework retry is fenced to the observed terminal Producer run, and duplicate scans converge through action and dispatch idempotency.
- Finalization reads current job generations and artifact-bound PASS attestations. Restart recovery finalizes an approved ready job, and finalized-job recovery re-enqueues only a missing or retryably expired delivery before retiring bindings.
- Final-delivery recovery still derives the existing exact `finny-final:<job>:<ledger>` key. Replacing that relation requires the Phase 5 durable delivery-intent shape and was not changed without its human schema gate.
- The remaining prefix-based completion guess was in an Auditor compatibility branch used when the generic `runs` table was absent. The Producer restart scan also fell back to binding expiry without `runs`, while final-delivery recovery treated every finalized job as actionable without `deliveries`. Core initializes its run, delivery, and Finny binding stores before recovery, so these branches represented weaker second lifecycles rather than production modes. They were deleted instead of repaired. Store tests now initialize the real Core stores, and runtime tests model dispatches by advancing durable run identity.
- Disposable production-shaped backlogs using the real Core run schema returned all 250 actionable recoveries. Terminal Auditor scans measured 17.2, 17.4, 17.4, 17.6, and 17.8 ms; median 17.4 ms. Successful-but-incomplete terminal Producer scans measured 36.6, 36.7, 37.3, 37.5, and 38.0 ms; median 37.3 ms. These are diagnostic measurements, not an SLA. The query result and reconciliation loop remain unbounded and serial, so no arbitrary cap was added without an observed bottleneck.
- All 27 `test/finny*.test.ts` files, typecheck, changed-path ESLint/oxlint, and FinnyLoop r5 pass. The recovery suite proves duplicate convergence and per-job poison isolation. Firefox rendered the isolated production-shaped web portal. The exact implementation head then completed the production-shaped Slack recovery acceptance described below.
- No database table, column, index, constraint, enum, persisted/API payload, configuration setting, default, provider, or supported combination changed. No migration or backfill is required.

#### 2026-11-18 production-shaped Slack recovery acceptance

- A real Slack DM created and approved a durable synthetic AP-aging plan. The test stopped Core while the first Producer was active, converted only that intercepted run to a terminal failure in the disposable QA database, and restarted Core against the same database.
- Recovery preserved the job and admitted exactly one replacement Producer run in the same durable worker session. The failed run remained terminal, the replacement completed, one current artifact digest was bound, and one Auditor epoch opened after `artifact_ready`.
- The bound workbook reconciled invented bills of INR 16,428,820 less payments of INR 3,960,260 and credits of INR 296,000 to open AP of INR 12,172,560 with zero variance. All eight current checks passed against the bound digest. Stale output created by the parent during the crash window was not accepted as job authority.
- Finalization produced one signed receipt. The exact final-delivery key was enqueued once and delivered once, 1.5 seconds after finalization, with no failed or expired delivery. Producer and Auditor bindings were retired after completion.
- Recovery dispatch evidence contained one delivered `producer_retry` and one delivered `auditor_retry`, with no cancelled duplicate. The Auditor retry was the targeted wake that supplied the one omitted `artifact.integrity` verdict; repeated deterministic submissions remained harmless but are included in the timing diagnosis below.
- This acceptance used the existing schema and configuration surface. `persistent_subagents` was enabled only in the disposable QA database, as required by the existing Finny runtime; file watching was disabled only for the stable fault-injection run. Neither setting changed repository defaults.

#### Slack recovery eval timing and acceleration note

This is diagnostic evidence from a deliberately disrupted QA run, not a steady-state latency result or an SLA:

| Interval                                             | Observed time | What dominated it                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack request to certified delivery                  |        17m31s | Plan generation and approval, environment diagnosis, controlled failure, repeated development restarts, full workbook construction, audit, and delivery                                                                     |
| Durable plan registration to finalization            |        16m35s | The complete approved lifecycle after the plan record existed                                                                                                                                                               |
| Approval to finalization                             |        15m53s | Producer admission/recovery, artifact production, independent audit, and one targeted Auditor wake                                                                                                                          |
| Controlled Producer failure to replacement admission |          5.9s | Core restart and durable recovery convergence                                                                                                                                                                               |
| Replacement Producer admission to `artifact_ready`   |         7m07s | Synthetic fixture generation, workbook construction, formula and reconciliation checks, Files publication, and upload/digest path discovery; development file watching also caused repeated restarts before it was disabled |
| `artifact_ready` to first PASS                       |         1m05s | Auditor artifact download, independent recomputation, and deterministic evaluator startup                                                                                                                                   |
| `artifact_ready` to finalization                     |         3m45s | Eight-check audit, repeated deterministic submissions, identification of the omitted `artifact.integrity` check, and the targeted wake that supplied it                                                                     |
| Finalization to visible Slack delivery               |          1.5s | Durable outbox delivery                                                                                                                                                                                                     |

The run used 113 recorded model requests across the parent, replacement Producer, and Auditor: 208 uncached input tokens, 66,880 output tokens, 4,409,138 cache-read tokens, and 231,782 cache-write tokens. The high output and cache traffic include the injected crash, development restart churn, duplicate workbook work by the parent, and repeated deterministic audit calls; they are not a clean performance baseline.

The largest avoidable delays were test-environment and protocol-discovery costs, not recovery convergence itself. The feature flag required for persistent workers was initially off, the watch-mode development process restarted active turns repeatedly, the model explored multiple upload paths before using the existing Files route, and the Auditor initially treated `artifact.integrity` as a deterministic-worker check even though the deterministic worker owns only `formula.recalculate`, `summary.crossfoot`, and `artifact.structure`.

Future evals can be faster without changing Phase 3 behavior by preflighting the worker feature flag and Slack delivery before starting the clock, using non-watch mode for crash injection, providing the canonical Files upload/digest procedure in the eval brief, stating the deterministic-versus-judgment check ownership map explicitly, checking current attestations before rerunning the deterministic audit, and separating environment setup time from lifecycle time. No such optimization is implemented in this phase.

Exit criteria:

- A successful Pi response without `artifact_ready` cannot orphan a job.
- A successful Auditor response without all required verdicts cannot orphan a job.
- Restarting Core converges to the same next action without duplicating work.
- Poison jobs do not block recovery for unrelated jobs.

### Phase 4/5 audit, result, and delivery schema gate

Status: Implemented on the Phase 4/5 branch. The detailed proposal below records the human schema review that authorized implementation. Where it differs from the implemented contract recorded at the end of this gate, the implemented contract is authoritative. No live database has been migrated by this branch work.

This gate authorizes the Phase 4 clean cutover from independently submitted check attestations to one immutable audit attempt per artifact and the Phase 5 cutover from receipt-derived presentation to one certified result with one durable delivery. It does not authorize the finance corpus, accounting gold, controlled live-source population, an absolute SLA, or changes to the parent → Producer → independent audit topology.

#### Current TypeScript and API authority

The current write API accepts one check at a time:

```ts
interface RecordFinnyAuditPassedInput {
  scopeId: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  artifactDigest: string;
  evidenceDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
}

interface RecordFinnyAuditBlockInput extends RecordFinnyAuditPassedInput {
  findings: Array<{ code: string; message: string }>;
  changeKinds: FinnyChangeKind[];
  resolution: { kind: "rework" } | { kind: "escalate"; reason: string };
}

interface FinnyAttestation {
  seq: number;
  id: string;
  jobId: string;
  checkId: FinnyCheckId;
  generation: number;
  verdict: "pass" | "block";
  evidenceDigest: string;
  artifactDigest: string;
  issuerPrincipalId: string;
  issuerRunId: string;
  deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  idempotencyKey: string;
  createdAt: number;
}

interface FinnyResultReceiptPayload {
  aud: "finny.final.delivery";
  resultId: string;
  jobId: string;
  scopeId: string;
  sopVersionId: string;
  sopRevision: number;
  executionDigest: string;
  artifactFileId: string;
  artifactDigest: string;
  auditAttemptId: string;
  auditDigest: string;
  approvalRequestId: string;
  approvalActorId: string;
  originThreadRef: string;
  deliveryId: string;
  issuedAt: number;
}
```

Each submission also writes an `audit_passed` or `audit_blocked` job event. Finalization reads the latest attestation for each check, compares its generation with `finny_jobs.required_generations`, requires the current artifact and evaluator, signs `FinnyFinalReceipt`, and stores that receipt directly on the job. `finnyFinalDelivery` then reconstructs the summary from the SOP and derives `finny-final:<jobId>:<ledgerHead>`; no typed certified business summary or durable result owner exists.

#### New TypeScript and API authority

The cutover replaces the per-check write methods and finalization input with these complete public store shapes:

```ts
type FinnyDetailRef =
  | { kind: "xlsx"; fileId: string; sheet: string; range: string }
  | { kind: "evidence"; evidenceId: string; selector: string }
  | { kind: "app"; fileId: string; view: string; parameters: Record<string, string> };

interface FinnyAuditControlResult {
  controlId: string;
  verdict: "pass" | "block";
  evidenceRefs: FinnyDetailRef[];
  findings: Array<{ code: string; message: string; detailRefs: FinnyDetailRef[] }>;
  repairActions: Array<{ instruction: string; detailRefs: FinnyDetailRef[] }>;
}

interface FinnyAuditJudgmentAddendum {
  auditorPrincipalId: string;
  auditorRunId: string;
  questions: Array<{
    controlId: string;
    question: string;
    verdict: "pass" | "block";
    rationale: string;
    evidenceRefs: FinnyDetailRef[];
  }>;
}

interface FinnyAuditAttempt {
  schema: "finny.audit-attempt.v1";
  id: string;
  jobId: string;
  scopeId: string;
  attempt: number;
  sopVersionId: string;
  sopRevision: number;
  executionDigest: string;
  artifact: {
    fileId: string;
    sha256: string;
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  };
  evaluator: FinnyEvaluatorRef;
  evidenceManifest: Array<{ evidenceId: string; digest: string; mediaType: string }>;
  controls: FinnyAuditControlResult[];
  judgment?: FinnyAuditJudgmentAddendum;
  verdict: "pass" | "block";
  auditDigest: string;
  createdAt: number;
}

interface RecordFinnyAuditAttemptInput {
  scopeId: string;
  jobId: string;
  artifact: FinnyAuditAttempt["artifact"];
  evaluator: FinnyEvaluatorRef;
  evidenceManifest: FinnyAuditAttempt["evidenceManifest"];
  controls: FinnyAuditControlResult[];
  judgment?: FinnyAuditJudgmentAddendum;
  idempotencyKey: string;
  createdAt: number;
}

interface FinnyCertifiedMetric {
  id: string;
  label: string;
  value: string;
  detailRefs: FinnyDetailRef[];
}

interface FinnyCertifiedResult {
  schema: "finny.result.v1";
  id: string;
  jobId: string;
  scopeId: string;
  sopVersionId: string;
  sopRevision: number;
  executionDigest: string;
  artifact: FinnyAuditAttempt["artifact"];
  summary: {
    period: string;
    currency: string;
    metrics: FinnyCertifiedMetric[];
    exceptions: Array<{ text: string; material: boolean; detailRefs: FinnyDetailRef[] }>;
    caveats: Array<{ text: string; detailRefs: FinnyDetailRef[] }>;
  };
  auditAttemptId: string;
  receipt: FinnyFinalReceipt;
  deliveryId: string;
  createdAt: number;
}

interface FinalizeFinnyResultInput {
  scopeId: string;
  jobId: string;
  auditAttemptId: string;
  summary: FinnyCertifiedResult["summary"];
  destination: Destination;
  idempotencyKey: string;
}
```

`recordAuditAttempt` is the only audit write. Core validates that controls appear exactly once in SOP order, every required control is present, all references resolve to the bound artifact or evidence manifest, the aggregate verdict equals the control and judgment verdicts, and the optional judgment is issued by the current independent Auditor run. Core assigns `id`, `attempt`, `auditDigest`, SOP bindings, and artifact authority; callers cannot select them.

`finalizeResult` is the only finalization write. It validates the summary against the SOP output contract, the PASS attempt against the current job binding, the XLSX artifact identity, approval, and destination. In one PostgreSQL transaction it inserts the delivery, result, job result reference, receipt, and finalization timestamp. Slack and web receive the same serialized certified result rather than independently rebuilding figures.

#### Current PostgreSQL ownership

Current audit authority is `finny_attestations(seq BIGSERIAL PRIMARY KEY, id UNIQUE, job_id REFERENCES finny_jobs ON DELETE CASCADE, check_id, generation, verdict, evidence_digest, artifact_digest, issuer_principal_id, issuer_run_id, deterministic_authority JSONB, idempotency_key UNIQUE, created_at)`. Its indexes are `(job_id, check_id, generation, seq DESC)` and `(job_id, seq)`.

Current audit history is duplicated in `finny_job_events`: `audit_passed` and `audit_blocked` payloads repeat check, generation, artifact, evidence, issuer, deterministic authority, and BLOCK findings. `finny_jobs.required_generations`, `ledger_head`, `pending_rework_seq`, and `unresolved_escalation_seq` coordinate the per-check lifecycle.

Current completion authority is `finny_jobs.finalization_key`, `final_receipt JSONB`, and `finalized_at`. The generic `deliveries` table owns the queued surface message, with primary key `id`, unique `idempotency_key`, JSONB `destination`, text, optional JSONB attachments and provenance, recipient thread, delivery/expiry/failure/claim timestamps, shadow flag, latency fields, and its existing pending, recipient, shadow, and provenance indexes. There is no foreign key from a job or receipt to the delivery row.

#### New PostgreSQL shape

```sql
CREATE TABLE finny_audit_attempts(
  id TEXT PRIMARY KEY CHECK (id <> ''),
  scope_id TEXT NOT NULL CHECK (scope_id <> ''),
  job_id TEXT NOT NULL REFERENCES finny_jobs(id),
  attempt BIGINT NOT NULL CHECK (attempt > 0),
  sop_version_id TEXT NOT NULL CHECK (sop_version_id <> ''),
  sop_revision BIGINT NOT NULL CHECK (sop_revision > 0),
  execution_digest TEXT NOT NULL CHECK (execution_digest <> ''),
  artifact_file_id TEXT NOT NULL CHECK (artifact_file_id <> ''),
  artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
  artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  evaluator_ref JSONB NOT NULL CHECK (jsonb_typeof(evaluator_ref) = 'object'),
  evidence_manifest JSONB NOT NULL CHECK (jsonb_typeof(evidence_manifest) = 'array'),
  controls JSONB NOT NULL CHECK (jsonb_typeof(controls) = 'array' AND jsonb_array_length(controls) > 0),
  judgment_addendum JSONB CHECK (judgment_addendum IS NULL OR jsonb_typeof(judgment_addendum) = 'object'),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','block')),
  audit_digest TEXT NOT NULL UNIQUE CHECK (audit_digest <> ''),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key <> ''),
  created_at BIGINT NOT NULL,
  UNIQUE(job_id, attempt),
  UNIQUE(job_id, artifact_digest),
  FOREIGN KEY(scope_id, sop_version_id) REFERENCES finny_sop_versions(scope_id, version_id)
);

CREATE INDEX finny_audit_attempts_job_created
  ON finny_audit_attempts(job_id, created_at DESC);
CREATE INDEX finny_audit_attempts_scope_created
  ON finny_audit_attempts(scope_id, created_at DESC);

CREATE FUNCTION reject_finny_audit_attempt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finny audit attempts are immutable';
END;
$$;

CREATE TRIGGER finny_audit_attempts_immutable
  BEFORE UPDATE OR DELETE ON finny_audit_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_finny_audit_attempt_mutation();

CREATE TABLE finny_results(
  id TEXT PRIMARY KEY CHECK (id <> ''),
  scope_id TEXT NOT NULL CHECK (scope_id <> ''),
  job_id TEXT NOT NULL UNIQUE REFERENCES finny_jobs(id),
  sop_version_id TEXT NOT NULL CHECK (sop_version_id <> ''),
  sop_revision BIGINT NOT NULL CHECK (sop_revision > 0),
  execution_digest TEXT NOT NULL CHECK (execution_digest <> ''),
  artifact_file_id TEXT NOT NULL CHECK (artifact_file_id <> ''),
  artifact_digest TEXT NOT NULL CHECK (artifact_digest <> ''),
  artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  search_text TEXT NOT NULL CHECK (search_text <> ''),
  audit_attempt_id TEXT NOT NULL UNIQUE REFERENCES finny_audit_attempts(id),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
  created_at BIGINT NOT NULL,
  FOREIGN KEY(scope_id, sop_version_id) REFERENCES finny_sop_versions(scope_id, version_id)
);

CREATE INDEX finny_results_scope_created
  ON finny_results(scope_id, created_at DESC);
CREATE INDEX finny_results_search
  ON finny_results USING GIN(to_tsvector('simple', search_text));

CREATE FUNCTION reject_finny_result_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Finny results are immutable';
END;
$$;

CREATE TRIGGER finny_results_immutable
  BEFORE UPDATE OR DELETE ON finny_results
  FOR EACH ROW EXECUTE FUNCTION reject_finny_result_mutation();

ALTER TABLE finny_jobs ADD COLUMN current_audit_attempt_id TEXT REFERENCES finny_audit_attempts(id);
ALTER TABLE finny_jobs ADD COLUMN result_id TEXT UNIQUE REFERENCES finny_results(id);
ALTER TABLE finny_jobs ADD CONSTRAINT finny_jobs_result_finalization_pair
  CHECK ((result_id IS NULL) = (finalized_at IS NULL));
```

The migration then drops `finny_jobs.required_generations`, `ledger_head`, `pending_rework_seq`, `finalization_key`, and `final_receipt`; drops `finny_attestations`; and removes `audit_passed`, `audit_blocked`, `evidence_invalidated`, `rework_cancelled`, and `verification_reopened` from the job-event enum. It adds `audit_recorded` with `{ auditAttemptId, artifactDigest, verdict }` and retains `rework_requested` with `{ auditAttemptId }` or `escalated` with `{ auditAttemptId, reason }`. `current_audit_attempt_id` is cleared when a replacement artifact binds and set only when its complete immutable attempt is inserted. No per-check event or generation counter remains.

JSON validation is not limited to `jsonb_typeof`: application validators enforce every field shown in the TypeScript shapes, reject unknown fields, require unique ordered control and metric IDs, validate `FinnyDetailRef` discriminants, require evidence IDs to exist in the manifest, require XLSX references to name the bound file, and require the result receipt, attempt, SOP, artifact, execution digest, scope, job, destination, and approval to agree. Canonical JSON digests cover the entire attempt except its assigned ID, idempotency key, and creation time.

#### Evidence ownership

The file artifact store remains the owner of immutable workbook and optional mini-app bytes. Existing evidence storage remains the owner of source extracts and deterministic evidence bodies. `finny_audit_attempts.evidence_manifest` stores only stable IDs, media types, and digests; control findings and repair actions point to those IDs or exact workbook locations. The attempt owns verdicts, linkage, and the complete audit envelope, not copied source data. `finny_results` owns the certified business summary and stable detail references, not workbook cells or evidence bodies. `deliveries` owns delivery lifecycle and surface payload. The signed receipt binds the result ID, PASS attempt ID, artifact, SOP revision, execution digest, approval, destination, and issue time.

#### Invented before and after rows

The following examples are invented and contain no client data.

Before, one artifact is represented by eight rows like this and a receipt on the job:

```json
{
  "finny_attestations": [
    {
      "seq": 41,
      "id": "finny-audit-invented-1",
      "job_id": "job-invented-ap",
      "check_id": "summary.crossfoot",
      "generation": 1,
      "verdict": "pass",
      "evidence_digest": "sha256:invented-evidence",
      "artifact_digest": "sha256:invented-workbook",
      "issuer_principal_id": "auditor-invented",
      "issuer_run_id": "run-invented",
      "deterministic_authority": { "reasonSchemaVersion": "finny.spreadsheet-worker.v2" },
      "idempotency_key": "invented-check-key",
      "created_at": 1795010000000
    }
  ],
  "finny_jobs": {
    "id": "job-invented-ap",
    "required_generations": { "summary.crossfoot": 1 },
    "ledger_head": 48,
    "finalization_key": "invented-finalization",
    "final_receipt": { "token": "invented-signed-token", "payload": { "ledgerHead": 48 } },
    "finalized_at": 1795010100000
  }
}
```

After, one attempt, result, and delivery own the same completed work:

```json
{
  "finny_audit_attempts": {
    "id": "audit-invented-1",
    "scope_id": "org:invented-company",
    "job_id": "job-invented-ap",
    "attempt": 1,
    "sop_version_id": "sop.ap.aging.inr@1",
    "sop_revision": 1,
    "execution_digest": "sha256:invented-execution",
    "artifact_file_id": "file-invented-workbook",
    "artifact_digest": "sha256:invented-workbook",
    "artifact_mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "evaluator_ref": {
      "id": "spreadsheet",
      "revision": "invented",
      "buildDigest": "sha256:invented-build",
      "contractVersion": "1",
      "configurationDigest": "sha256:invented-config"
    },
    "evidence_manifest": [
      { "evidenceId": "source-control-total", "digest": "sha256:invented-evidence", "mediaType": "application/json" }
    ],
    "controls": [
      {
        "controlId": "summary.crossfoot",
        "verdict": "pass",
        "evidenceRefs": [{ "kind": "xlsx", "fileId": "file-invented-workbook", "sheet": "Summary", "range": "B7" }],
        "findings": [],
        "repairActions": []
      }
    ],
    "judgment_addendum": null,
    "verdict": "pass",
    "audit_digest": "sha256:invented-audit",
    "idempotency_key": "invented-attempt-key",
    "created_at": 1795010000000
  },
  "finny_results": {
    "id": "result-invented-1",
    "scope_id": "org:invented-company",
    "job_id": "job-invented-ap",
    "sop_version_id": "sop.ap.aging.inr@1",
    "sop_revision": 1,
    "execution_digest": "sha256:invented-execution",
    "artifact_file_id": "file-invented-workbook",
    "artifact_digest": "sha256:invented-workbook",
    "artifact_mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "summary": {
      "period": "2026-10-31",
      "currency": "INR",
      "metrics": [
        {
          "id": "total-ap",
          "label": "Total AP",
          "value": "125000.00",
          "detailRefs": [{ "kind": "xlsx", "fileId": "file-invented-workbook", "sheet": "Summary", "range": "B7" }]
        }
      ],
      "exceptions": [],
      "caveats": []
    },
    "search_text": "invented AP aging INR 2026-10-31",
    "audit_attempt_id": "audit-invented-1",
    "receipt": {
      "token": "invented-signed-token",
      "payload": { "resultId": "result-invented-1", "auditAttemptId": "audit-invented-1" }
    },
    "delivery_id": "delivery-invented-1",
    "created_at": 1795010100000
  },
  "deliveries": {
    "id": "delivery-invented-1",
    "idempotency_key": "finny-result:result-invented-1",
    "destination": { "type": "slack", "channel": "invented-channel", "threadTs": "invented-thread" },
    "text": "serialized finny.result.v1 projection",
    "attachments": [{ "fileId": "file-invented-workbook" }],
    "delivered_at": null
  },
  "finny_jobs": {
    "id": "job-invented-ap",
    "current_audit_attempt_id": "audit-invented-1",
    "result_id": "result-invented-1",
    "finalized_at": 1795010100000
  }
}
```

#### Migration, backfill, rollout, and rollback

The migration is a clean cutover, not a dual-read period. It first creates the new tables and columns, then refuses to continue if an unfinished job has a current artifact or unresolved rework, escalation, evaluator correction, or audit dispatch. Operators either let those audits finish under the old release or explicitly restart them before the migration. Approved jobs with no artifact remain valid and begin under the new audit path after deployment.

Finalized historical jobs, attestations, events, receipts, and delivery rows are retained in archival tables renamed `finny_attestations_history` and `finny_job_events_history`; they remain readable through the historical job view but are never treated as current authority. No `finny_results` row is fabricated for old jobs because the old system did not persist a typed summary. No audit attempt is synthesized from per-check rows because that would falsely claim one atomic verification. After retention export and the documented retention window, archival removal requires a separate operator action; the application never mutates those rows.

The cutover transaction verifies that every newly finalized job has exactly one PASS attempt, result, delivery, and matching job reference before dropping old columns and write methods. Rollback before the destructive step is ordinary deployment rollback. After the clean cutover, rollback means restoring the pre-cutover database backup and release together; code does not dual-write old attestations or reconstruct generation state.

New audit attempts and results follow the job's retention and are retained immutably with it. The foreign keys deliberately restrict deletion of a job, attempt, result, delivery, artifact, or evidence while a retained certified result references it. Any future purge policy requires a separately reviewed archival migration; there is no application delete path in this gate. Generic delivery retry and status retention behavior remains unchanged, but the referenced Finny delivery row cannot be purged independently. Historical signed receipts remain verifiable with their original payload contract.

#### Authorization and surface compatibility

All store reads require matching `scope_id`. Audit-attempt writes require the active Core deterministic stage and, when judgment exists, the current role-bound Auditor principal/run for the same job and artifact. Result finalization remains Core-only and requires the approved actor, origin thread, exact execution digest, current PASS attempt, and destination match. Detail references resolve through existing file/evidence authorization; a result never turns a private file ID into a public URL. Download URLs are generated at read time after authorization and are not persisted in the result or delivery.

Slack and web render the same `finny.result.v1` projection. Surface adapters may change layout but cannot change figures, exceptions, caveats, artifact identity, audit verdict, or receipt. Old finalized jobs keep their historical receipt-based rendering. New callers must submit one complete audit attempt and typed summary; old per-check methods and payloads are removed and fail as unsupported rather than being translated.

No environment variable, setting, feature flag, provider, model, default, precedence rule, or supported configuration combination is added or changed. The existing artifact byte limit, delivery lifecycle, destination authorization, SOP approval, evaluator authority, and runtime binding configuration remain in force.

#### Implemented Phase 4/5 contract

The implementation deliberately keeps finalized legacy receipts, attestations, and job events readable as historical authority. New agent-facing writes no longer expose `finny_pass` or `finny_block`: one `finny_deterministic_audit` call records the complete deterministic envelope, and `finny_finalize` requires the typed summary. Legacy store methods remain only for historical runtime recovery and are not a current agent write path.

The exact new public shapes are:

```ts
interface FinnyAuditAttempt {
  id: string;
  jobId: string;
  scopeId: string;
  sopVersionId: string;
  executionDigest: string;
  artifactFileId: string;
  artifactSha256: string;
  artifactMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  artifactSizeBytes: number;
  evaluator: FinnyEvaluatorRef;
  controls: Array<{
    id: string;
    verdict: "pass" | "block";
    evidenceRefs: string[];
    repairActions: Array<{ message: string; workbookRefs: string[] }>;
    deterministicAuthority?: FinnyDeterministicEvidenceAuthority;
  }>;
  judgmentQuestions: unknown[];
  judgmentAddendum?: FinnyAuditJudgmentAddendum;
  verdict: "pass" | "block" | "pending_judgment";
  issuerPrincipalId: string;
  issuerRunId: string;
  idempotencyKey: string;
  createdAt: number;
  completedAt?: number;
}

interface FinnyCertifiedResult {
  schema: "finny.result.v1";
  jobId: string;
  sopVersionId: string;
  executionDigest: string;
  artifact: {
    fileId: string;
    sha256: string;
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  };
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

Summary detail references must use `xlsx:`, `evidence:`, or `app:` prefixes. The strict validator rejects unknown fields, a non-XLSX artifact, an invalid SHA-256, and duplicate metric IDs. Certification additionally checks every reference against the bound result authorities.

Migrations `finny/store/0014-audit-attempts`, `0015-certified-results`, and `0016-audit-result-cutover` add these exact persisted shapes:

```sql
finny_audit_attempts(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES finny_jobs(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  sop_version_id TEXT NOT NULL REFERENCES finny_sop_versions(version_id),
  execution_digest TEXT NOT NULL,
  artifact_file_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  artifact_size_bytes BIGINT NOT NULL CHECK (artifact_size_bytes > 0),
  evaluator_ref JSONB NOT NULL,
  controls JSONB NOT NULL,
  judgment_questions JSONB NOT NULL DEFAULT '[]',
  judgment_addendum JSONB,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','block','pending_judgment')),
  issuer_principal_id TEXT NOT NULL,
  issuer_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  UNIQUE(job_id, artifact_sha256)
);

finny_results(
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES finny_jobs(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  schema TEXT NOT NULL CHECK (schema = 'finny.result.v1'),
  sop_version_id TEXT NOT NULL REFERENCES finny_sop_versions(version_id),
  execution_digest TEXT NOT NULL,
  artifact_file_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_mime TEXT NOT NULL CHECK (artifact_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  summary JSONB NOT NULL,
  audit_attempt_id TEXT NOT NULL UNIQUE REFERENCES finny_audit_attempts(id),
  receipt JSONB NOT NULL,
  destination JSONB NOT NULL,
  delivery_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  search_text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
```

`finny_jobs.current_audit_attempt_id` and `finny_jobs.result_id` are unique foreign keys. Audit-attempt indexes cover `(job_id, created_at DESC, id DESC)`, `(scope_id, created_at DESC, id DESC)`, and pending judgment. Result indexes cover `(scope_id, created_at DESC, id DESC)`, full-text search, and the partial pending-delivery queue. When the generic `deliveries` table exists, `finny_results.delivery_id` references it.

The result transaction writes the typed result, signed receipt, exact destination, result-owned idempotency key, job result reference, finalization time, and approval consumption together. `delivery_id` is intentionally nullable at that point: the stored destination is the durable delivery intent. Startup or inline recovery projects it to the generic outbox with `finny-result:<resultId>` and then binds the returned delivery ID. This closes the crash window without pretending a generic delivery exists before its own transaction commits.

Invented representative rows:

```json
{
  "finny_audit_attempts": {
    "id": "audit-invented-1",
    "job_id": "job-invented-1",
    "artifact_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "controls": [
      { "id": "summary.crossfoot", "verdict": "pass", "evidenceRefs": ["evidence:invented-1"], "repairActions": [] }
    ],
    "verdict": "pass",
    "completed_at": 1795010000000
  },
  "finny_results": {
    "id": "result-invented-1",
    "job_id": "job-invented-1",
    "schema": "finny.result.v1",
    "summary": {
      "period": "2026-10-31",
      "currency": "INR",
      "metrics": [
        {
          "id": "total-ap",
          "label": "Total AP",
          "value": "125000.00",
          "detailRefs": ["xlsx:file-invented-1#Summary!B7"]
        }
      ],
      "exceptions": [],
      "caveats": []
    },
    "destination": { "type": "slack", "target": "invented-channel" },
    "delivery_id": null,
    "idempotency_key": "certify-invented-1"
  }
}
```

Migration `0016` refuses startup when unfinished legacy work has an artifact, pending rework, unresolved escalation, or nonzero ledger but no atomic current attempt. It does not synthesize an attempt or result, does not dual-read new authority from per-check rows, and does not modify historical finalized data. No backfill is performed because the old system never persisted a typed certified summary. Rollback before applying these migrations is an ordinary code rollback; after application, database and code must roll back together from the pre-migration backup.

No repository setting or runtime configuration changed. `PUBLIC_WEB_URL` is an existing Finny prerequisite and is used to generate the authorized workbook link at delivery time. The finance corpus, accounting gold, controlled source population, and performance SLA remain unapproved.

### Phase 4 — Deterministic audit and targeted rework

Status: Implemented and locally verified; independent review and CI pending

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

Authorized schema contract:

- Show old per-check events and the proposed atomic audit payload.
- Show indexes, constraints, event semantics, evidence fields, and representative rows.
- Decide whether old audit rows are migrated, retained read-only, or cut over cleanly.

Exit criteria:

- Artifact bytes and deterministic evidence are read and verified once per audit attempt.
- A revised workbook receives one coherent audit attempt.
- Rework receives only actionable failed-check context.
- Auditor independence and check-level evidence remain inspectable.

### Phase 5 — Certified output and durable delivery

Status: Implemented and locally verified; independent review and CI pending

Goal: Make completion mean the user received a clean workbook and useful certified summary.

Implementation units:

- Persist a typed certified summary produced under the SOP summary contract.
- Validate that the final artifact is a real XLSX before certification.
- Write finalization and delivery intent atomically or through one durable outbox boundary.
- Render Slack and QM app output from the same certified result.
- Deliver workbook, summary, exceptions, caveats, audit status, and receipt together.
- Validate required delivery configuration at startup rather than after finalization.

Authorized schema contract:

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

| Date       |     Phase | Change                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                              | Status                                                        | Owner             |
| ---------- | --------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| 2026-11-17 |  Research | Audited current Finny lifecycle, latest upstream QM, Pi harness, and LoopForge                                                                                                                                                                      | Source review at downstream `f2d342f9`, upstream `b3ba0524`, LoopForge `86b0ee06`                                                                                                                                                                                                                                                                                                                                     | Complete                                                      | Research agents   |
| 2026-11-17 |  Planning | Established phased high-performance SOP harness plan                                                                                                                                                                                                | This document                                                                                                                                                                                                                                                                                                                                                                                                         | Complete                                                      | Primary agent     |
| 2026-11-17 |  Planning | Resolved SOP, approval, audit, result, baseline-fixture, and evaluation design decisions                                                                                                                                                            | This document and current QM eval audit                                                                                                                                                                                                                                                                                                                                                                               | Complete pending human schema/corpus review                   | Primary agent     |
| 2026-11-17 |   Phase 0 | Added a production-independent baseline analyzer for Producer/Auditor run counts, pre-artifact Auditor detection, query-to-certified-delivery time, and parent/Producer/Auditor tokens with fail-closed missing usage                               | [Analyzer and tests](#phase-0--baseline-and-completion-trace); paired web and Slack measurements are linked in the implementation summary                                                                                                                                                                                                                                                                             | Complete                                                      | Evaluation lane   |
| 2026-11-17 |   Phase 1 | Corrected Finny tool vocabulary, removed placeholder dispatch turns, opened Producer only after approval with its real task, opened Auditor only after artifact commit, and recovered terminal successful-but-incomplete workers from durable state | [Web evidence](#phase-01-live-measurement--qm-web): one Producer, one post-artifact Auditor, certified XLSX, 21.6% fewer tokens. [Slack evidence](#phase-01-live-measurement--slack): one Producer, one post-artifact Auditor, certified attached XLSX, 43.2% fewer tokens.                                                                                                                                           | Complete on web and Slack; latency improvement not yet proven | Integration owner |
| 2026-11-17 |   Phase 1 | Preserved the durable Finny plan request identity across the generic web approval boundary after live QA exposed a false-success dispatch                                                                                                           | RED: web Finny tool test observed no durable `finny-plan:<requestId>` approval key. GREEN: the tool retains the request identity; the orchestrator decides that Finny request; the live Producer opened immediately after approval.                                                                                                                                                                                   | Complete                                                      | Integration owner |
| 2026-11-17 |   Phase 1 | Closed the material-clarification handoff so every persisted option and `Other` is actionable, the exact ready plan is projected immediately, and Finny translation stays outside the generic orchestrator                                          | RED: caller-visible Postgres tests proved the prior code ignored alternate options, treated `Other` as command denial, and returned no next approval. GREEN: affected core/web suites, typecheck, and oxlint pass. Chrome shows all options and `Other`; selecting a nonrecommended date records that exact choice and requires revision.                                                                             | Complete                                                      | Integration owner |
| 2026-11-17 |   Phase 1 | Exercised the `Other` clarification path against the running production-shaped web instance in Chrome                                                                                                                                               | Session `762bf470-2392-4f1e-8456-1446297f9c5a`: `Other` consumed the durable Finny clarification and returned `Revision is required before this plan can be approved. Submit a revised plan to continue.` The composer reopened for the revised input.                                                                                                                                                                | Complete                                                      | Production QA     |
| 2026-11-17 |   Phase 1 | Closed both clarification commit-to-projection crash windows without adding another recovery queue                                                                                                                                                  | RED: a committed clarification replay returned no usable result, and an injected plan-projection failure could delete the clarification approval before its replacement existed. GREEN: the service reconstructs the durable result idempotently and the orchestrator persists the replacement before deleting its predecessor.                                                                                       | Complete; no schema or configuration change                   | Integration owner |
| 2026-11-17 |   Phase 1 | Proved terminal successful-but-incomplete Producer recovery through the exact-head production-shaped web surface                                                                                                                                    | [Live terminal-run recovery](#phase-1-live-terminal-run-recovery--qm-web): first run `done`/`ok` with no artifact; durable `producer_retry` bound a new run in the same session; artifact, independent eight-check audit, receipt, workbook, and certified summary followed.                                                                                                                                          | Complete                                                      | Production QA     |
| 2026-11-17 |   Phase 1 | Bound clarification replay to its exact durable Finny job instead of the newest pending approval in the Slack or web thread                                                                                                                         | RED: a two-job Postgres regression reproduced clarification A displaying newer plan B. GREEN: replay resolves readiness and the replacement approval by `scope_id` plus `job_id`; affected approval, web, and store tests pass.                                                                                                                                                                                       | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Made every persisted clarification option actionable without another human turn                                                                                                                                                                     | RED: a nonrecommended option ended with an instruction to repeat the choice. GREEN: the parent resumes with the exact recorded option, amends the existing job, withdraws the stale approval, and projects the durable replacement plan approval; `Other` still opens free-form revision.                                                                                                                             | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Bound automatic worker recovery to the terminal run observed by the durable scan                                                                                                                                                                    | RED: replaying one stale Producer or Auditor recovery snapshot dispatched twice and could replace healthy work. GREEN: recovery carries the observed run ID and dispatches only while the active binding still matches it; the existing compare-and-swap advances the binding atomically.                                                                                                                             | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Excluded human-wait and refused terminal outcomes from automatic Producer and Auditor recovery                                                                                                                                                      | RED: `done` runs returning `pending_approval` or `refused` were eligible for restart. GREEN: the durable recovery census distinguishes those outcomes from missing, failed, expired-live, and successful-but-incomplete work, with regressions for both roles.                                                                                                                                                        | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Preserved the real actor and integration-parent request binding across an alternate-choice plan amendment                                                                                                                                           | RED: the replacement approval used a fallback actor and the original parent request ID, so approval could claim success without Producer dispatch. GREEN: amendment updates both bindings atomically; a non-default actor approves the replacement and opens one Producer for the same job.                                                                                                                           | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Applied the durable run-outcome census to fresh Auditor reverification admission                                                                                                                                                                    | RED: a fresh reverification Auditor waiting on approval was selected for another wake because no delivery marker existed. GREEN: active run state preserves `pending_approval` and `refused` work even after binding expiry while retaining recovery for missing, failed, expired-live, and incomplete runs.                                                                                                          | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Moved guarded admission validation ahead of worker interruption inside the shared session admission lock                                                                                                                                            | RED: a stale Finny dispatch could stop a healthy replacement before its compare-and-swap rejected the write. GREEN: `beforeEnqueue` runs under the admission lock before `stopSessionRuns`; a rejected guarded interrupt leaves the active run healthy.                                                                                                                                                               | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 1 | Verified the complete alternate-choice flow on the exact-head production-shaped web instance in Chrome                                                                                                                                              | Session `fa96216e-87a4-4ca9-b2ed-c54b1aa74263`: the user selected `2026-11-30`; QM resumed the same parent without another human message, presented a replacement plan explicitly bound to the alternate cutoff, accepted approval, and visibly started one Producer subagent.                                                                                                                                        | Complete                                                      | Production QA     |
| 2026-11-17 |   Phase 1 | Bound reverification recovery to the exact Auditor run observed by the durable scan                                                                                                                                                                 | RED: replaying one orphaned, terminal, or expired reverification recovery could target a replacement or stall on an expired binding. GREEN: active bindings retry in the same session with an observed-run guard; missing bindings admit once; stale replay is ignored; the obsolete delivery-prefix lookup is removed.                                                                                               | Complete; no database schema or configuration change          | Integration owner |
| 2026-11-17 |   Phase 2 | User authorized task-level SOP implementation and verification as the next milestone after the Phase 1 PR is complete                                                                                                                               | This document remains the working contract; first record the complete human-readable old/new schema and migration review, then implement one finance-specific SOP persistence and execution slice.                                                                                                                                                                                                                    | Queued                                                        | Integration owner |
| 2026-11-18 |   Phase 2 | Added the durable next-session implementation handover                                                                                                                                                                                              | [Handover](./2026-11-18-finny-sop-phase-2-handover.md) links the authoritative design, exact schema gate, TDD sequence, live/eval measurements, guardrails, and definition of done.                                                                                                                                                                                                                                   | Ready after Phase 1 PR completion                             | Integration owner |
| 2026-11-18 |   Phase 2 | Recorded the complete old/new SOP and job schema review before implementation                                                                                                                                                                       | [Phase 2 SOP and job schema gate](#phase-2-sop-and-job-schema-gate) covers TypeScript, tool/API, PostgreSQL, field accounting, invented rows, canonicalization, migration, unfinished jobs, rollout, rollback, compatibility, and unchanged configuration.                                                                                                                                                            | Awaiting human review; no persisted-shape code written        | Integration owner |
| 2026-11-18 |   Phase 2 | Implemented immutable `finny.sop.v1` authority and cut active execution over to exact SOP bindings                                                                                                                                                  | Commits `cace9f55a` through `1857c698a`; approval binds the execution digest, material amendments invalidate approval with provenance, Producer and Auditor compile from the same version, and unfinished legacy jobs fail migration while finalized legacy history remains readable.                                                                                                                                 | Complete; approved schema live only in isolated QA PostgreSQL | Integration owner |
| 2026-11-18 |   Phase 2 | Verified the affected implementation and clarified the artifact binding exposed by live acceptance                                                                                                                                                  | All 27 `test/finny*.test.ts` files pass, focused agent-tool tests pass, typecheck and FinnyLoop r5 pass, and changed implementation paths pass ESLint. Repository-wide ESLint still reports two unchanged baseline errors in `plugins/web-ui/src/generative-card.ts` and `src/slack/generative-ui.ts`.                                                                                                                | Complete                                                      | Integration owner |
| 2026-11-18 |   Phase 2 | Completed a real-model AP-aging approval, production, deterministic audit, targeted rework, certification, and delivery in Firefox                                                                                                                  | Web session `3a3fbec7-0d78-47d5-b22e-b726abe12af5`, job `b424e17b-9bba-459d-90df-001603898d51`, SOP `personal%3Akalicharanshukla/sop.ap.aging.inr@1`. The first artifact was blocked on `summary.crossfoot`; the replacement passed events 6–13 and delivered digest `0aa5b159…0eac7ec0`.                                                                                                                             | Complete; diagnostic run, not a performance baseline          | Production QA     |
| 2026-11-18 |   Phase 2 | Recorded diagnostic timing and model usage for the accepted web run                                                                                                                                                                                 | Job creation to finalization was 11m58s; approval to finalization was 11m14s; first artifact to finalization was 4m14s; replacement artifact to finalization was 2m15s. Parent, Producer, and two Auditor sessions used 250 uncached input, 71,996 output, 5,701,677 cache-read, and 540,443 cache-write tokens.                                                                                                      | Complete; includes QA recovery and is not an SLA comparison   | Production QA     |
| 2026-11-18 |   Phase 2 | Kept later authority gates closed                                                                                                                                                                                                                   | No `finny_audit_attempts` or `finny_results` schema was added. No repository configuration changed; `persistent_subagents` was enabled only in the isolated QA database to exercise the configured dev instance. The synthetic corpus and independent accounting gold remain unapproved.                                                                                                                              | Complete                                                      | Integration owner |
| 2026-11-18 |   Phase 2 | Completed exact-DM Slack acceptance and both amendment paths on the final implementation                                                                                                                                                            | Slack job `fa06a262-ae65-4ec1-9324-6982b7cd5328` passed clarification, approval, deterministic BLOCK, corrected artifact, certification, and one receipt delivery. Web job `d7e7740c-5bb1-4d78-90fb-45973a3b90b2` proved non-material approval retention and origin-bound material replacement request `finny-amend-haHvZP0HPPnJu8suSzs-8phln58LNjUYRP8ArOoB43Q`.                                                     | Complete                                                      | Production QA     |
| 2026-11-18 |   Phase 2 | Closed performance and token review findings                                                                                                                                                                                                        | Worker tool schemas omit parent-only SOP authoring fields; SOP search pages IDs before definitions; final recovery ignores pending, delivered, and permanently failed deliveries while retaining retryable expiry and binding cleanup. Independent final reviews accepted Performance 96/100, Token performance 98/100, and production-like QA 98/100.                                                                | Complete                                                      | Review owners     |
| 2026-11-18 |   Phase 2 | Merged the complete SOP slice through the required merge path                                                                                                                                                                                       | [PR #35](https://github.com/11mirror/qm/pull/35) merged to `main` as `897066570`; the review instance was then stopped and its pool lease and ports were verified free while shared PostgreSQL data was preserved.                                                                                                                                                                                                    | Complete                                                      | Integration owner |
| 2026-11-18 |   Phase 3 | Established the next implementation boundary                                                                                                                                                                                                        | Phase 1 already owns durable successful-but-incomplete recovery. The next session begins with a complete terminal/finalization/delivery path census, then closes only confirmed completion-authority gaps without entering the Phase 4 or Phase 5 schema gates. See the [Phase 3 handover](./2026-11-18-finny-phase-3-handover.md).                                                                                   | Next                                                          | Integration owner |
| 2026-11-18 |   Phase 3 | Completed the terminal, finalization, restart, and delivery census and removed table-absence recovery lifecycles                                                                                                                                    | Review established that Core initializes typed durable run, delivery, and Finny binding state before recovery. Weaker Producer, Auditor, and final-delivery compatibility branches were deleted; tests now initialize the real stores and advance durable run identity on dispatch. The exact final-delivery key remains behind the Phase 5 delivery-intent gate.                                                     | Locally complete; independent review pending                  | Integration owner |
| 2026-11-18 |   Phase 3 | Closed the delivered-rework terminal gap                                                                                                                                                                                                            | A Producer that terminates successfully without replacing a BLOCKed artifact is redispatched from the unresolved durable rework transition. The retry is fenced to the observed run, uses a distinct idempotency generation, and duplicate recovery scans dispatch once without repeating escalation judgment.                                                                                                        | Locally complete; independent review pending                  | Integration owner |
| 2026-11-18 |   Phase 3 | Verified crash convergence, duplicate recovery, poison isolation, and representative backlog behavior                                                                                                                                               | All 27 Finny suites pass. Real 250-job backlogs returned every recovery: Auditor median 17.4 ms; successful-but-incomplete Producer median 37.3 ms, each over five warm scans. No arbitrary cap, schema, persisted payload, or configuration changed; typecheck, lint, and FinnyLoop r5 pass.                                                                                                                         | Complete locally; no SLA claimed                              | Integration owner |
| 2026-11-18 |   Phase 3 | Booted isolated production-shaped web and Slack surfaces                                                                                                                                                                                            | Firefox rendered the QM portal. A pooled Slack app held one Socket Mode connection. Slack event-delivery acceptance remains pending because no canary channel was available; a pre-existing QA database that failed the Phase 2 legacy-job guard was left unchanged.                                                                                                                                                  | Web accepted; Slack recovery acceptance pending               | Production QA     |
| 2026-11-18 |   Phase 3 | Completed production-shaped Slack crash recovery, certification, and single delivery                                                                                                                                                                | The interrupted Producer became terminal; restart admitted one replacement, bound the workbook, passed eight checks, finalized one receipt, and delivered the exact key once. The timing note separates the 17m31s diagnostic run from environment and model work.                                                                                                                                                    | Complete; diagnostic run, not an SLA baseline                 | Production QA     |
| 2026-11-18 | Phase 4/5 | Recorded and authorized the atomic audit-attempt, certified-result, and durable-delivery schema gate                                                                                                                                                | The gate specifies complete old/new TypeScript, API, PostgreSQL, keys, indexes, constraints, JSON fields, invented rows, evidence ownership, clean migration, retention, authorization, surface compatibility, and unchanged configuration. Implementation may proceed; no live schema change is claimed by this documentation commit.                                                                                | Authorized; implementation in progress                        | Integration owner |
| 2026-11-18 | Phase 4/5 | Implemented and locally verified atomic audit, targeted rework, certified results, and result-owned delivery                                                                                                                                        | All 25 focused Finny/web test files, typecheck, changed-file lint, and FinnyLoop r5 pass. Chrome proved a live model response and durable Finny plan approval in the isolated personal scope. The existing pool3 Sharechat/personal instance stayed live and unchanged; branch Slack QA awaits another pooled Slack app. No repository configuration changed; schema migrations ran only in the isolated QA database. | Complete locally; independent review and CI pending           | Integration owner |

## Required human decisions for later gates

1. Complete: the SOP/job schema was reviewed, approved, implemented, and merged in PR #35.
2. Complete on the branch: the Phase 4 atomic audit-attempt shape, evidence ownership, cutover refusal, event semantics, and targeted rework are implemented and locally verified.
3. Complete on the branch: the Phase 5 certified-summary/result shape, result-owned durable delivery intent, startup recovery, authorization, and surface projection are implemented and locally verified.
4. Pending before the versioned high-performance eval: approve the synthetic/de-identified corpus and independently calculated accounting gold.
5. Pending before Tier 4: approve the controlled NetSuite/test-source population and cleanup.
6. Pending before performance becomes a release gate: review paired baseline variance, classify existing defects, and approve any absolute SLA; otherwise comparisons remain variance-based.
