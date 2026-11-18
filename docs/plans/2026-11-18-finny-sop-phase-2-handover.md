# Finny Phase 2 SOP Implementation Handover

Status: Complete and superseded after [PR #35](https://github.com/11mirror/qm/pull/35) merged as `897066570`; continue with the [Phase 3 handover](./2026-11-18-finny-phase-3-handover.md)
Date: 2026-11-18  
Authoritative design and evidence: [Finny High-Performance SOP Harness](./2026-11-17-finny-high-performance-sop-harness.md)  
Phase 1 review: [11mirror/qm#34](https://github.com/11mirror/qm/pull/34)

## Completed outcome

The smallest durable, finance-specific task SOP slice is implemented, independently reviewed, accepted on web and Slack, and merged. The separately gated audit/result schemas and corpus remain outside Phase 2.

Phase 1 is complete at implementation commit `db90d6cf5`: Finny uses the real tool contract, opens the Producer only after approval, opens the Auditor only after an artifact, and recovers incomplete terminal work from durable job state. Do not redesign that topology.

PR #34 merged through the required merge path as `7d40666e7`; PR #35 merged Phase 2 as `897066570`. The user approved the complete schema review recorded in the [Phase 2 SOP and job schema gate](./2026-11-17-finny-high-performance-sop-harness.md#phase-2-sop-and-job-schema-gate), and the approved shape is implemented. Audit-attempt and certified-result shapes remain separate human gates.

## Historical Phase 2 execution checklist

The checklist below is retained as implementation history. Do not use it to start new work; use the [Phase 3 handover](./2026-11-18-finny-phase-3-handover.md).

1. Read `docs/SPEC.md`, `CODING_STANDARDS.md`, `REVIEW.md`, this handover, and the full high-performance plan.
2. Confirm PR #34 is complete through the merge queue. Never bypass it with an admin merge.
3. Update local `main`, then create a new `codex/finny-sop-v1` branch. Do not stack Phase 2 implementation on the Phase 1 PR.
4. Keep the Mac caffeinated while this work is active. Release caffeine only after the agreed SOP slice and its verification are complete.
5. Before writing any persisted-shape code, add the complete human-readable old/new schema review to the high-performance plan and present it for human review. This is the intended approval pause.
6. Use strict test-driven development: prove each behavior through a failing caller-visible test before implementing it.

## Authoritative decisions

Use the decisions already recorded in the high-performance plan:

- The SOP belongs to one finance task and version. It contains objective, typed inputs, systems of truth, ordered accounting logic, controls, output contracts, approval destination, and optional rerun inputs.
- The first domains are AP, AR, GL, and close. The model may draft an SOP, but Core validates, canonicalizes, versions, and persists it.
- Approval binds the canonical execution digest. Objective, material inputs and values, sources, ordered steps, controls, output contracts, rerun inputs, and approval destination invalidate approval when changed. Display and search metadata do not.
- The same approved SOP version is read by the Producer and the independent audit stage.
- Deterministic checks run first. Pi judgment is used only when a declared judgment predicate fires or deterministic evidence cannot resolve a control.
- Each Finny job exposes a concise, searchable SOP and certified-result summary with stable references to details.
- LoopForge contributes SOP discipline and deterministic contracts, not its DAG, node runtime, nested SOP engine, or retry framework.
- Token use and elapsed time across the parent, Producer, and any Pi Auditor are release measurements, not optional diagnostics.

## First implementation slice

### 1. Complete the schema gate

Document the exact current and proposed shapes before a migration is written.

The current shape includes `FinnyJob.plan`, `planDigest`, `finny_jobs.plan_presentation`, and `finny_jobs.plan_digest`. Trace the complete caller and persistence surface through:

- `src/finny/types.ts`
- `src/finny/plan.ts`
- `src/finny/store.ts`
- `src/finny/postgres-store.ts`
- `src/finny/integration.ts`
- `src/agent/agent-tools/finny.ts`

The review must show:

- complete old and new TypeScript, tool/API, and PostgreSQL shapes;
- every key, index, constraint, enum, and JSON field;
- fields retained, moved, transformed, added, or dropped;
- invented and clearly labelled before/after rows;
- migration, backfill, compatibility, rollout, rollback, and unfinished-job treatment;
- whether existing `plan_presentation` remains temporarily for migration or is replaced in the same cutover.

Do not implement `finny_audit_attempts` or `finny_results` in this slice. Those persisted shapes have separate later human gates.

### 2. Build the pure SOP contract first

Add failing tests, then implement:

- the minimal `finny.sop.v1` type and structural validator;
- canonicalization and one execution digest;
- material versus non-material amendment behavior;
- finance-specific source, step, control, workbook/summary, and optional rerun contracts;
- deterministic compilation into the Producer task and independent audit envelope.

The contract must reject unknown or ambiguous executable fields. It must not contain DAG edges, arbitrary node types, nested SOPs, model-selected retry budgets, or prompt-level authority.

### 3. Add immutable durable versions

After the schema review is accepted, add the PostgreSQL migration and store behavior for immutable SOP versions plus the job's exact SOP/version, bound inputs, and execution digest. Test organization scoping, version immutability, digest uniqueness where selected by the reviewed design, restart survival, and migration/backfill behavior.

### 4. Integrate without changing the Finny lifecycle

- The parent drafts or selects an SOP and asks only material clarifications.
- The approval card is rendered from the same durable SOP version that will execute.
- Approval authorizes that exact execution digest.
- The Producer's first turn receives the real compiled task after approval.
- The audit stage receives the same SOP only after a valid artifact is committed.
- A material amendment invalidates prior approval and creates explicit revision provenance.
- Existing durable job-state reconciliation remains the completion authority.

### 5. Verify with the first finance fixture

Use the invented AP-aging fixture in the high-performance plan: multiple currencies, partial payments, credits, a material unmapped vendor classification, cutoff-boundary transactions, a repeatable workbook, a certified summary, and optional rerun parameters.

Run affected tests plus typecheck and lint. Then use a production-shaped dev instance and Chrome to exercise one complete task through approval, Producer work, artifact validation, deterministic audit, conditional Pi judgment if genuinely triggered, and delivery.

Record in the high-performance plan:

- commit and branch;
- exact focused tests and checks;
- live session and artifact identifiers;
- correctness verdicts and failed edge cases;
- parent, Producer, Auditor, and total tokens;
- query-to-certified-delivery time, system-controlled time, and artifact-ready-to-delivery time;
- comparison with the Phase 0/1 baseline without claiming a latency improvement from one run.

## Required evaluation coverage

The first candidate must cover normal execution plus missing required input, unavailable source, source population drift, duplicate rows, cutoff ambiguity, currency mismatch, formula breakage, workbook structure failure, stale artifact, restart/compaction, alternate approval choice, material amendment, audit BLOCK, and targeted rework.

Hard failures include wrong-scope SOP reuse, execution under a stale approval digest, missing source lineage, pre-artifact audit, successful Pi completion without durable stage completion, or delivery without the required XLSX and certified summary.

## Definition of done

- The complete old/new SOP and job schema is recorded and human-reviewed before its migration is implemented.
- A versioned SOP is immutable and durable in PostgreSQL.
- Approval binds the canonical execution digest and material changes invalidate it.
- Producer and audit compilation derive from the same SOP version.
- The independent audit stage runs deterministic controls first and spends LLM tokens only for bounded judgment.
- A restart or Pi compaction cannot lose the approved SOP or its job binding.
- The AP-aging candidate produces a verified XLSX, typed certified summary, audit evidence, receipt, and one durable delivery record.
- Focused tests, typecheck, lint, production-shaped Chrome QA, and the versioned eval pass.
- Token and time measurements are recorded in the high-performance plan.
- The running implementation log is updated with links to details, and the Phase 2 PR contains the required schema/config disclosure and independent Wall of shame reviews.
- Caffeine is released only after this definition of done is met or the user explicitly stops the work.

## Do not do

- Do not create a separate `finny-staging` deployment or Slack bot.
- Do not replace the QM parent, Finny Producer, or independent audit topology.
- Do not import LoopForge's runtime or build a generic workflow engine.
- Do not restore placeholder Pi turns or pre-create workers.
- Do not use an LLM to recheck arithmetic, workbook structure, or source totals that deterministic code can decide.
- Do not treat a completed Pi response as a completed Finny stage.
- Do not weaken actor, origin, SOP digest, artifact digest, or run compare-and-swap bindings.
- Do not change audit-attempt or certified-result persisted shapes without their separate human schema review.

## Copyable next-session instruction

Continue Finny from `docs/plans/2026-11-18-finny-phase-3-handover.md`. Use `docs/plans/2026-11-17-finny-high-performance-sop-harness.md` as the running source of truth, branch from updated `main`, and begin with the Phase 3 durable completion-path census.
