---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
title: Finny Dynamic Plan Amendment and Scope Change Approval
created_at: 2026-11-11
---

## Goal Capsule

- **Objective:** Operators and agents can dynamically amend active in-flight Finny finance job plans with 1-click Slack Block Kit approvals, preventing state-machine deadlocks when financial reporting scope expands mid-turn.
- **Means:** Introduce `finny_amend_plan` tool and approval protocol into QM's core orchestrator, postgres store, and Slack approval bridge.
- **Product Authority:** Finance operators in the Slack origin thread; QM authoritative Finny store.
- **Open Blockers:** None.

---

## Product Contract

### Summary

Add a dynamic plan amendment capability (`finny_amend_plan`) to the QM/FinnyLoop harness. When financial intent changes mid-stream (such as introducing dual-view statutory vs. normalized economic adjustments), the agent presents an amended plan specification and triggers an inline Slack approval card without aborting or deadlocking the active job.

### Problem Frame

Under the current QM FinnyLoop architecture, a job's `plan_digest` is immutable once approved. When downstream requirements expand (e.g. conversational requests for dual-view normalized reporting), the agent recognizes that the approved plan contract excludes normalization. The Auditor blocks unapproved methodology, but the harness lacks any mechanism to amend the in-flight plan. The agent re-evaluates invariants on each turn, re-asserts the blocker, and enters an infinite repetition loop asserting bureaucratic compliance instead of producing the deliverable.

### Key Decisions

- KD1. **Dynamic Amendment Over Plan Cancellation:** Jobs retain their lifecycle continuity; `finny_amend_plan` supersedes the active `plan_digest` rather than forcing the user to abandon and recreate the job from scratch. (session-settled: user-directed — chosen over provisional uncertified drafts and conversational intent relaxation: preserves full audit compliance while removing bureaucratic deadlock) Governs R1, R2, R3.
- KD2. **1-Click Slack Scope-Change Card:** Scope changes render as a compact diff highlighting changed assumptions, metrics, and new auditor checks, requiring an authorized finance operator's single click. Governs R4, R5.
- KD3. **Auditor Check Re-generation:** When a plan is amended, QM resets pending auditor blocks for newly authorized methodologies while preserving prior passing checks where invariants remain valid. Governs R6, R7.

### Actors

- A1. **Finance Producer Agent:** Generates financial calculations, identifies scope shifts, calls `finny_amend_plan`, and produces workbooks once unblocked.
- A2. **Finance Operator (Slack):** Reviews the amendment diff card in the origin Slack thread and clicks "Approve Scope Change".
- A3. **QM Core Harness & Finny Store:** Stores updated `plan_digest`, manages job event transitions, and re-keys worker grants.
- A4. **Finny Auditor Worker:** Evaluates evidence against the amended plan invariants.

### Requirements

**Plan Amendment Lifecycle**

- R1. QM MUST expose a native `finny_amend_plan` tool to the agent runtime when `FINNY_ENABLED=true`.
- R2. `finny_amend_plan` MUST accept an updated `FinnyPlanPresentation` and optional clarification context matching the existing schema of `finny_create_plan`.
- R3. Calling `finny_amend_plan` on an active job MUST transition the job state from blocked/producing into `awaiting_amendment_approval` without dropping existing job history or lineage.

**Slack Fast-Approval UI**

- R4. QM MUST post a Slack Block Kit card in the job's origin thread displaying the plan amendment title, summary of changes, and an "Approve Scope Change" button.
- R5. Clicking "Approve Scope Change" MUST validate that the actor is authorized and record an `amendment_approved` event updating `approval_plan_digest` to the new canonical hash.

**Verification and Rework Dispatch**

- R6. Upon approval, QM MUST clear deadlocked `rework_requested` states tied to the previous scope restriction and issue a fresh producer worker grant for the amended scope.
- R7. The Auditor checklist MUST evaluate the revised invariants specified in the amended plan, enabling dual-view or normalized adjustments to pass verification.

### Key Flows

- F1. Mid-Stream Scope Amendment & Execution
  - **Trigger:** User requests Dual-View (As-Booked + Normalized Economic) reporting for an in-flight close job whose initial plan excluded normalization.
  - **Actors:** A1, A2, A3, A4
  - **Steps:**
    1. Producer detects scope change and drafts `DUAL_VIEW_METHOD_REVIEW.md`.
    2. Instead of looping on the blocker, Producer calls `finny_amend_plan` with updated phases, formulas, and required dual-view invariants.
    3. QM creates an amendment approval request and posts an inline Block Kit card to the Slack thread.
    4. Finance Operator clicks "Approve Scope Change".
    5. QM records `plan_amended` event, updates active `plan_digest`, clears the block, and wakes Producer.
    6. Producer compiles the Q3 dual-view MIS workbook and uploads artifact digest.
    7. Auditor runs deterministic and dual-view tie-out checks and passes the workbook.
  - **Outcome:** Workbook produced and certified without manual CLI or database intervention.
  - **Covers:** R1, R2, R3, R4, R5, R6, R7

### Scope Boundaries

- **In Scope:**
  - `finny_amend_plan` agent tool implementation.
  - Database schema and event types for plan amendments (`finny_jobs`, `finny_job_events`, `finny_approval_requests`).
  - Slack Block Kit amendment card and approval action handler in `FinnyApprovalBridge`.
  - Runtime coordinator dispatch to resume producer on amendment approval.
- **Outside Scope (Deferred):**
  - Uncertified provisional output delivery (provisional drafts without auditor verification).
  - Conversational NLP parsing of free-text approvals in Slack threads.

### Acceptance Examples

- AE1. Scope expansion amendment
  - **Covers:** R1, R4, R5, R6
  - **Given:** Job `Job876cc203` is blocked because initial plan excluded normalization.
  - **When:** Agent calls `finny_amend_plan` with normalized dual-view additions, and operator approves the card.
  - **Then:** Job transitions to `producing`, `event_head` increments with `plan_amended`, and producer compiles without deadlock.
