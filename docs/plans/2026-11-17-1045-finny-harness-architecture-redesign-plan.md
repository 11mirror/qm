---
title: "Finny Governance & Harness Architecture: Scope Binding Simplification, SOP Preflight Skill, and Approval Deduplication"
date: "2026-11-17"
topic: "finny-harness-architecture-redesign"
artifact_contract: "ce-unified-plan/v1"
product_contract_source: "ce-brainstorm"
execution: "code"
---

## Goal Capsule

- **Objective:** Eliminate brittle multi-tenant file scope barriers between personal and organization contexts during Finny audits, enforce deep accounting SOP and interactive clarification cards in preflight planning, and ensure single-emission approval messages in the user interface.
- **Means:** Contextual file scope matching in Core/Finny integration (KTD1), SOP plan decomposition prompt guidelines (KTD2), and deduplicated UI approval completion path in orchestrator (KTD3).
- **Product Authority:** Scope is limited to the Finny governance lifecycle, Core file artifact verification rules, preflight plan resolution/presentation, and Web UI approval handling. Other domain skills, NetSuite credentials, and external messaging transports remain unchanged.
- **Execution Profile:** Ships as a single coordinated change across `src/finny/integration.ts`, `src/core/orchestrator.ts`, and test suites.
- **Stop Conditions:** All tests in `test/finny-*.test.ts` pass, typecheck passes cleanly with zero errors, and approval confirmations render exactly once.
- **Shipped By:** `ce-work` / `lfg` autonomous pipeline.

---

## Product Contract

### Summary

FinnyLoop governance currently trips over rigid scope constraints (`ownerScopeId` personal vs job `scopeId` org), presents shallow preflight plans without operational SOP decomposition, and doubles approval confirmations in the Web UI. This plan establishes a unified contextual file-eligibility model, integrates a dedicated SOP decomposition and gap-clarification card stage, and deduplicates approval messages across chat surfaces.

### Problem Frame

Finny orchestrates audited financial reconciliations by coordinating three roles: parent conversational session, Producer worker, and Auditor worker. In practice, three critical defects break this governance flow:

1. **Scope Binding Friction:** When Producer or Auditor subagents upload workbooks and evidence via `/v1/files/upload`, Core tags them with `ownerScopeId: "personal:<actorId>"` and `createdInScope: "<jobScopeId>"`. Core Finny verification previously demanded an exact string match between `artifact.ownerScopeId` and the job's `scopeId`, immediately rejecting valid workbooks with immutable file scope mismatch errors.
2. **Superficial Preflight Planning:** The initial plan presented to human stakeholders often lists generic phases without detailing the exact operational SOP (NetSuite tables, SuiteQL joins, account exclusions, crossfoot formulas, or currency basis). When ambiguity exists, workers execute based on unverified assumptions rather than presenting interactive clarification cards.
3. **Double Approval Confirmation:** Approving a plan card in the Web UI results in twin confirmation messages rendered back-to-back in the chat transcript due to dual emission in `orchestrator.ts` and the UI streaming runner.

### Key Decisions

- **KD1 (Contextual Scope Eligibility):** (session-settled: user-directed — chosen over rigid exact ownerScopeId match: prevent false-positive scope rejections). Files authored or created within the project or organization scope hierarchy are valid for Finny audit binding as long as the cryptographic SHA-256 digest and worker provenance match. Governs R1, R2.
- **KD2 (Preflight SOP Decomposition & Mandatory Clarification):** (session-settled: user-directed — chosen over immediate execution: prevent assumption-based workbook generation). Before presenting a plan for human approval, the intent pipeline must decompose the request into a concrete accounting SOP. If any parameter, period status, or account mapping is ambiguous, the system must trigger question-answer clarification cards first. Governs R3, R4, R5.
- **KD3 (Single-Source Approval Confirmation):** (session-settled: user-approved — chosen over dual emit: clean transcript hygiene). The approval response text is emitted through a single coordinated path so that transcripts and live UI streams never display duplicate confirmation messages. Governs R6.

### Requirements

#### Scope Binding & Immutable File Authority

- R1. Finny artifact proposal resolution (`resolveFinnyFileArtifactProposal`) and evidence verification (`immutableScopedFileBytes`) must accept files whose `createdInScope` matches the job's scope or whose `ownerScopeId` is personal while the job runs within the organization hierarchy.
- R2. Cryptographic artifact integrity (SHA-256 digest, byte size limits, and deterministic worker principal provenance) must remain strictly enforced regardless of scope relaxation.

#### Preflight SOP Planning & Clarification Loop

- R3. Financial queries routed to FinnyLoop must trigger a domain-specific SOP decomposition detailing:
  - Exact data sources, NetSuite tables, transaction types, and joins.
  - Accounting basis (book currency vs transaction currency, FX netting rules).
  - Explicit account exclusions and filtering criteria (e.g., Account 606702 exclusions, MSME tags).
  - Reconciled balance controls, crossfoot tolerances, and sheet layouts.
- R4. If the intent extraction or SOP generation identifies missing parameters, period ambiguity, or conflicting criteria, the system must issue interactive clarification cards to the user before requesting plan approval.
- R5. Plan presentation must display the concrete SOP phases and output schema so the human reviewer evaluates exact operational mechanics before approving execution.

#### User Interface & Transcript Hygiene

- R6. Interactive plan approval in the Web UI must produce exactly one confirmation message in the transcript, resolving the dual-emission race between `orchestrator.ts` and `core-bridge.ts`.

### Key Flows

- F1. **Governed Financial Request with Clarification:**
  - **Trigger:** User asks for an end-to-end P2P trace or AP outstanding report.
  - **Actors:** Human, Finny Intent Resolver, Plan SOP Generator.
  - **Steps:**
    1. System classifies request as financial intent and identifies candidate SOP skill.
    2. SOP generator maps required fields and checks for missing parameters (e.g. cutoff date, subsidiary, book currency).
    3. If gaps exist, system renders an interactive clarification card with single-select or multi-select options.
    4. Upon user selection, system regenerates the concrete SOP and presents the interactive Finny Plan Approval card.
    5. User approves plan.
  - **Covers:** R3, R4, R5.

- F2. **Workbook Delivery & Independent Certification:**
  - **Trigger:** Producer completes openpyxl workbook and posts to `/v1/files/upload`.
  - **Actors:** Producer Subagent, Finny Coordinator, Deterministic Auditor.
  - **Steps:**
    1. File is stored with `ownerScopeId: "personal:<actorId>"` and `createdInScope: "org:<orgId>"`.
    2. Producer calls `finny_artifact_ready` with file ID and SHA-256 digest.
    3. Finny Coordinator verifies contextual scope eligibility and passes artifact to Auditor.
    4. Auditor executes deterministic checks (`formula.recalculate`, `summary.crossfoot`, `artifact.structure`) and submits signed evidence.
    5. Final certified receipt and workbook link are delivered to the origin thread.
  - **Covers:** R1, R2.

### Scope Boundaries

- **In Scope:**
  - File scope eligibility rules in `src/finny/integration.ts`.
  - Financial intent preflight prompts and clarification card generation in `src/finny/resolver/` and `src/core/orchestrator.ts`.
  - Approval acknowledgment deduplication in `src/core/orchestrator.ts` and `plugins/web-ui/src/chat.ts`.
- **Deferred / Non-Goals:**
  - Changing underlying NetSuite SuiteQL dialect or third-party connector auth.
  - Altering the deterministic spreadsheet worker contract (`finny.spreadsheet-worker.v2`).
  - Cross-organization file sharing outside the user's authenticated tenant.

### Acceptance Examples

- AE1. **Personal-to-Org Scope Resolution:**
  - **Given:** A Finny job initialized with `scopeId: "org:sharechat"`.
  - **When:** A Producer worker uploads an artifact resulting in `ownerScopeId: "personal:U123"` and `createdInScope: "org:sharechat"`.
  - **Then:** `resolveFinnyFileArtifactProposal` returns the verified file ID and SHA-256 digest without throwing a scope mismatch error.

- AE2. **Clarification Card Before Plan Approval:**
  - **Given:** A user requests a reconciliation query missing an explicit accounting period or cutoff date.
  - **When:** Finny processes the intent.
  - **Then:** An interactive clarification card is rendered first; the plan approval card remains withheld until the question is answered.

- AE3. **Single Confirmation on Web UI Plan Approval:**
  - **Given:** An active Finny Plan Approval card in the Web UI.
  - **When:** The user clicks "Approve Plan".
  - **Then:** The transcript receives exactly one confirmation message (`Finny plan "..." approved...`).

---

## Planning Contract

### Key Technical Decisions

- **KTD1 (Hierarchical Context Scope Matcher):** Implement `matchesFinnyFileScope(artifact, targetScopeId)` in `src/finny/integration.ts` that checks:
  1. `artifact.ownerScopeId === targetScopeId || artifact.createdInScope === targetScopeId`.
  2. If `targetScopeId` is an `org:` scope, allow artifacts authored in personal scopes or with `createdInScope` matching the org. Governs R1, R2.
- **KTD2 (Structured SOP Prompts & Interactive Preflight Cards):** In `src/core/orchestrator.ts`, update `Mandatory FinnyLoop Governance Harness` prompt instructions:
  - Require LLM to output explicit accounting SOP: systems, NetSuite tables, SuiteQL filters, account exclusions, crossfoot formulas.
  - Instruct the model to call `finny_create_plan` with `materialClarification` parameters if there are multiple interpretations or missing filters, surfacing questions before plan lock-in. Governs R3, R4, R5.
- **KTD3 (Approval Response Emission Single Path):** In `src/core/orchestrator.ts`, when handling `Finny Governance Plan Approval`, remove the duplicate `deps.sessions.append(writer, { kind: "AgentMessage", text: reply })` and rely on the turn's returned `reply` string that the UI stream runner already streams/appends, preventing double rendering in chat. Governs R6.

---

## Implementation Units

### U1. Contextual Scope Eligibility for Finny Files

- **Goal:** Enable artifacts created under personal scopes with org context to resolve cleanly in Finny artifact proposals and evidence evaluation.
- **Requirements:** R1, R2.
- **Files:** `src/finny/integration.ts`, `test/finny-integration.test.ts`.
- **Approach:** Add `matchesFinnyFileScope` helper and use it in `immutableScopedFileBytes` and `resolveFinnyFileArtifactProposal`.
- **Test Scenarios:**
  - Artifact created in personal scope with `createdInScope: org` resolves for proposal.
  - Evidence file created in personal scope with `createdInScope: org` opens and digests cleanly.
  - Out-of-org artifact continues to be rejected with 403 / mismatch.
- **Verification:** `node --test test/finny-integration.test.ts`.

### U2. Approval Confirmation Deduplication in Web UI

- **Goal:** Stop twin "Finny plan approved" messages in the chat transcript.
- **Requirements:** R6.
- **Files:** `src/core/orchestrator.ts`.
- **Approach:** In `orchestrator.ts` around line 2210, return `{ status: "ok", sessionId: session.id, reply }` without manually calling `deps.sessions.append(writer, { kind: "AgentMessage", text: reply })` beforehand, since the turn response handler already commits the reply to the session transcript.
- **Test Scenarios:**
  - Approving a Finny plan via Web UI generates exactly 1 message in the conversation transcript.
- **Verification:** Inspect transcript output in tests or mock turn execution.

### U3. Preflight Accounting SOP & Clarification Card Prompt Enforcement

- **Goal:** Guide LLM to generate rich accounting SOPs and trigger clarification cards before plan approval when parameters are ambiguous.
- **Requirements:** R3, R4, R5.
- **Files:** `src/core/orchestrator.ts`, `src/finny/resolver/resolver-index.ts`.
- **Approach:** Enhance `Mandatory FinnyLoop Governance Harness` prompt guidance in `src/core/orchestrator.ts` to instruct the model to produce detailed accounting SOPs (NetSuite tables, SuiteQL query logic, balance crossfoots) and use `materialClarification` question cards whenever missing periods/dates/currencies need human resolution before execution.
- **Test Scenarios:**
  - Prompt verification for financial turns contains explicit SOP requirements and clarification card instructions.
- **Verification:** `node --test test/finny-integration.test.ts`.

---

## Verification Contract

- **Test Commands:**
  - `node --test test/finny-integration.test.ts`
  - `npx tsc --noEmit`
- **Quality Gates:** Zero TypeScript compile errors, zero test failures, zero comments committed.

---

## Definition of Done

- All three implementation units (U1, U2, U3) are implemented and verified.
- Automated tests in `test/finny-integration.test.ts` pass cleanly.
- `npx tsc --noEmit` passes with 0 errors.
- No comments added to codebase per zero-comment coding standard.
