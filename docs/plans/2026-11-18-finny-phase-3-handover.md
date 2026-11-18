# Finny Phase 3 Core-Owned Completion Handover

Status: Ready to start from merged `main` at or after `897066570`
Date: 2026-11-18
Authoritative tracker: [Finny High-Performance SOP Harness](./2026-11-17-finny-high-performance-sop-harness.md)
Completed implementation: [PR #35](https://github.com/11mirror/qm/pull/35)

## Current position

Phases 0–2 are complete. Phase 2 merged immutable SOP versions, exact execution-digest approval, origin-bound material amendments, non-material approval retention, role-specific compilation, default-paged SOP search, action-filtered recovery, and production-shaped web/Slack acceptance.

Phase 3 is next. Its foundation already exists: durable job state redispatches successful-but-incomplete Producer and Auditor work, excludes human-wait/refused outcomes, and fences recovery to the observed run. Do not rebuild this as a new queue or state machine.

## Next session

1. Read `docs/SPEC.md`, `CODING_STANDARDS.md`, `REVIEW.md`, and the [Phase 3 section](./2026-11-17-finny-high-performance-sop-harness.md#phase-3--core-owned-completion).
2. Branch from updated `main` and census every Producer/Auditor terminal outcome, finalization boundary, restart scan, and delivery handoff.
3. Identify concrete paths that still infer completion from model prose, generic run-result text, or delivery-key prefixes. Record evidence before editing.
4. For each confirmed gap, write a caller-visible failing test, route the fix through existing durable job-state reconciliation, and delete the superseded guess.
5. Prove crash-boundary convergence, duplicate-scan idempotency, and poison-job isolation. Measure reconciliation against a representative recovery backlog so serial scans and unbounded actionable result sets are visible.
6. Run affected Finny tests, typecheck, lint, FinnyLoop r5, and production-shaped web/Slack recovery QA.
7. Update the authoritative tracker with commits, evidence, timing, token use, unresolved risks, and the next gate.

## Boundaries

- Do not add `finny_audit_attempts` or atomic audit-result persistence; that is Phase 4 and needs a separate human schema review.
- Do not add `finny_results` or change certified-summary/delivery persistence; that is Phase 5 and needs a separate human schema review.
- Do not approve the corpus, accounting gold, controlled live source, or an SLA on the user's behalf.
- Preserve the QM parent → Producer → independent audit topology and Pi as the turn harness.

## Copyable instruction

Continue Finny from `docs/plans/2026-11-18-finny-phase-3-handover.md`. Use `docs/plans/2026-11-17-finny-high-performance-sop-harness.md` as the authoritative tracker. Start from updated `main`, census every terminal, finalization, restart, and delivery path, then use strict TDD to close only confirmed Core-completion gaps through the existing durable job-state reconciler. Keep Phase 4 audit-attempt and Phase 5 certified-result schemas behind their separate human review gates, and update the tracker with evidence before handoff.
