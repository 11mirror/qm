---
title: "Enforce Finny Agentic Team Delegation and Real-Time Job Book Visibility"
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
date: 2026-11-14
---

## Goal Capsule

- **Objective:** Finance queries in QM automatically route through a collaborative, multi-agent team (Coordinator → Finny Producer → Finny Auditor) with real-time state ledger (`job_book`) progress updates in chat, eliminating solitary inline execution and uncertified workbook drops.
- **Means:** Enforce mandatory delegation on finance turns (disabling direct sandbox/terminal execution on the coordinator turn), gate execution on approved `finny_create_plan` cards, wire the approval event to dispatch role-bound Producer/Auditor subagents, and broadcast live `finny_jobs` state cards to Slack and Web Chat threads. (KTD1, KTD2, KTD3, KTD4)
- **Product Authority:** Finance operators in Slack/Web chat; QM authoritative Finny store and runtime coordinator.
- **Stop Conditions:** All implementation units pass local tests, full typecheck and linting clean, and live end-to-end multi-agent dispatch verified.

---

## Product Contract

### Summary

Transition QM's Finny finance harness from a single-agent inline executor into its intended governed multi-agent architecture. When a financial query arrives, the parent coordinator presents an explicit plan card. Upon human approval, QM dispatches a dedicated **Finny Producer** subagent to extract NetSuite balances and compile workbooks, followed by an independent **Finny Auditor** subagent to verify invariants and deterministic spreadsheet crossfoots. Each stage of the `job_book` ledger is rendered into the chat thread in real time.

### Problem Frame

Currently, when a finance request arrives (e.g. net worth reconciliation), the coordinator agent executes all calculations and Python scripts directly inline as a solitary agent. This occurs because:

1. `responsive_spine` delegation is disabled in feature flags, giving the parent agent direct access to `execute` (terminal/bash).
2. The agent skips `finny_create_plan` or produces workbooks prior to approval.
3. Without an approved plan event, `runtime-coordinator.ts` never opens or dispatches the role-bound Producer and Auditor subagents.
4. Users have no real-time transparency into whether an audit is running or what step the agentic team is executing.

### Requirements

- **R1 (Mandatory Finance Delegation):** When `isFinanceTurn` is true, QM MUST enforce `delegateWork = true` on the turn, stripping direct `execute` and terminal execution tools from the coordinator. The coordinator is strictly confined to user communication, plan creation, and subagent delegation.
- **R2 (Preflight Plan Gate):** In any financial turn, data extraction tools (NetSuite SuiteQL) and workbook authoring MUST be gated behind an approved `finny_create_plan` record.
- **R3 (Automated Agentic Team Dispatch):** Upon operator approval of the plan card (via Slack Block Kit or Web Chat card), QM's `runtime-coordinator` MUST automatically open and dispatch:
  - `Finny Producer` (with role grant `producer`, running in an isolated sandbox with openpyxl/SuiteQL tools).
  - `Finny Auditor` (with role grant `auditor`, independent of Producer, running deterministic recalculation and invariant checks).
- **R4 (Real-Time Job Book Visibility):** As `finny_jobs` and `finny_job_events` transition through lifecycle states (`plan_created` → `awaiting_approval` → `approved` → `producer_running` → `artifact_ready` → `auditing` → `certified_pass`), Core MUST post live, in-place status card updates to the originating thread.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 (Turn-Level Delegation Over Feature Flag Dependency):** Rather than requiring a manual global database edit of `responsive_spine`, `orchestrator.ts` will directly evaluate `delegateWork = requiresDelegation(input, delegationEnabled) || isFinanceTurn`. Governs R1.
- **KTD2 (Core Approval Dispatch Trigger):** Leverage existing `afterApproved()` in `src/wiring.ts` and `src/finny/runtime-coordinator.ts` to ensure `openProducer` and `openAuditor` sessions are enqueued and bound immediately when the operator clicks Approve. Governs R3.
- **KTD3 (Role-Specific Tool Isolation):** Ensure `Finny Producer` subagents receive SuiteQL and openpyxl file-upload capabilities, while `Finny Auditor` subagents receive `deterministic_audit`, `finny_pass`, and `finny_block` tools. Governs R2, R3.
- **KTD4 (Live JobBook Card Broadcaster):** Hook into `finny_job_events` appends in `postgres-store.ts` to push ephemeral or updating status blocks to the delivery target (`deliveries.enqueue`). Governs R4.

---

## Implementation Units

### U1. Mandatory Finance Delegation Gate

- **Goal:** Strip direct bash/Python execution from the parent agent on financial turns so it cannot execute alone inline.
- **Files:**
  - `src/core/orchestrator.ts`
  - `src/sessions/session-syscalls.ts`
  - `test/finnyloop-harness-spike.test.ts`
- **Approach:**
  - In `orchestrator.ts:996`, set `const delegateWork = requiresDelegation(input, delegationEnabled) || Boolean(isFinanceTurn && !conversation.threadRef.includes("subagent"));`.
  - When `delegateWork` is true, `execute` and `background` tools are excluded from `tools`, forcing the coordinator to present `finny_create_plan` and await delegation.
- **Verification:** Unit test proving that on finance turns, `delegateWork` is enabled and terminal execution is absent from the coordinator's toolset.

### U2. Seamless Multi-Agent Spawning on Plan Approval

- **Goal:** Verify and ensure that operator approval triggers automated opening and execution of Producer and Auditor worker runs.
- **Files:**
  - `src/finny/runtime-coordinator.ts`
  - `src/wiring.ts`
  - `test/finny-worker-grants.test.ts`
- **Approach:**
  - Audit `afterApproved()` in `src/finny/runtime-coordinator.ts` to ensure `deps.sessions.open(openProducer)` and `deps.sessions.open(openAuditor)` smoothly enqueue worker runs with correct `parentBinding`.
  - Ensure the Producer run receives its prompt instructions (`instruction` in `wiring.ts:2214`) instructing it to build the workbook and call `finny_artifact_ready`.
- **Verification:** Test asserting that `afterApproved` creates both worker session records and dispatches the producer grant.

### U3. Real-Time Job Book Status Card Updates in Chat

- **Goal:** Broadcast visual, real-time stage progression cards to Slack and Web Chat threads as jobs advance through their event ledger.
- **Files:**
  - `src/finny/integration.ts`
  - `src/slack/finny-cards.ts`
  - `src/finny/postgres-store.ts`
  - `test/slack-finny-cards.test.ts`
- **Approach:**
  - Introduce `finnyJobStatusCard(job, event)` generating a compact Block Kit / Markdown progress meter:
    `[📋 Plan Approved] ➔ [⚙️ Producer: Compiling Workbook] ➔ [🔍 Auditor: Awaiting Artifact]`
  - Enqueue delivery to the origin thread whenever `recordEvent` or `afterApproved` / `artifactReady` fires.
- **Verification:** Tests in `test/slack-finny-cards.test.ts` verifying rendering of each stage in the status card.

---

## Verification Contract

- **Automated Tests:**
  ```bash
  node --test test/finnyloop-harness-spike.test.ts
  node --test test/slack-finny-cards.test.ts
  node --test test/finny-worker-grants.test.ts
  npm run typecheck
  npx eslint src/core/orchestrator.ts src/finny/runtime-coordinator.ts src/finny/integration.ts
  ```
- **Quality Gates:** Zero typecheck errors, zero ESLint errors, zero comments left in modified repo files.

---

## Definition of Done

- [ ] Coordinator turn on finance requests is strictly conversational & delegative (`delegateWork = true`).
- [ ] Direct inline execution is prevented on finance turns.
- [ ] Human approval of `finny_create_plan` automatically initiates Producer and Auditor worker subagent sessions.
- [ ] Real-time `job_book` lifecycle progress cards post to the chat thread as events transition.
- [ ] All unit and regression tests pass cleanly.
