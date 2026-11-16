---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Unified Technical Plan: Self-Hosted Web Generative UI & Finny Plan Approval Cards

## Goal Capsule

- **Objective:** Enable QM's Web and Desktop applications (`plugins/web-ui`) to render interactive, structured governance plan cards with native action buttons (Approve, Reject, Request Change, Clarification Options) and self-hosted Generative UI components, without depending on external cloud keys (`THESYS_API_KEY`) or modifying Slack surface code.
- **Means:** Extend the Web UI's Lit approval componentry, bridge structured approval payloads from `src/agent/agent-tools/finny.ts` through Core's `/api/approvals/:requestId` endpoint into `FinnyApprovalBridge`, and mount open-source Generative UI elements natively inside `plugins/web-ui/src/stable-markdown.ts`. (KTD1, KTD2, KTD3)
- **Authority Hierarchy:** Product Contract > Planning Contract > Implementation Units.
- **Stop Conditions:**
  1. `finny_create_plan` on Web surfaces renders an interactive card with Title, Summary, Phases, Deliverable, and interactive action buttons ("Approve", "Reject", "Request Change").
  2. Clicking "Approve" on Web executes `FinnyApprovalBridge.decide()`, records the approval in Postgres, transitions the Finny job, and dispatches the Finny Producer subagent.
  3. Structured generative card tokens stream and render cleanly in Web Chat without third-party cloud API keys.
  4. Slack Block Kit and surface code remain 100% untouched and green in regression tests.

---

## Product Contract

### Summary

Bridge QM's governed FinnyLoop lifecycle to the Web UI surface. Provide full visual parity with Slack Block Kit cards directly inside QM Desktop and Web Chat using self-hosted Lit components, connecting interactive user approval directly to QM's multi-agent runtime coordinator.

### Problem Frame

QM previously developed rich Finny plan presentation cards, material clarification pills, and Generative UI cards exclusively for Slack (`src/slack/finny-cards.ts`). When running in the QM Web/Desktop app:

1. `finny_create_plan` triggers `NeedsApproval` with only the plan title string, dropping phases, deliverables, certifications, and clarification choices.
2. The Web UI's `composerApprovalPanel` only knows generic CLI bash commands (`Allow once`, `Deny`).
3. Web approvals posted to `/api/approvals/:requestId` clear Core's turn pause but never notify `FinnyApprovalBridge`, causing Finny jobs to stall indefinitely in `awaiting_approval`.
4. Output data falls back to plain text conversational markdown because the Web gateway lacks card presentation guidance.

### Requirements

- **R1:** When `finny_create_plan` is called from a Web session, Core MUST retain the full structured plan presentation and material clarification options in `PendingApprovalRecord`.
- **R2:** The Web UI (`plugins/web-ui`) MUST display an interactive card for Finny plans showing:
  - Header with plan title.
  - Plan summary and phase breakdown (Phase name, owner, dependencies).
  - Deliverable, destination, and certification targets.
  - Clarification options when material clarification is requested.
  - Primary "Approve" button, "Reject" button, and "Request Change" input/button.
- **R3:** When an operator approves or rejects a Finny plan card on Web:
  - The decision MUST route through `FinnyApprovalBridge.decide()`.
  - The job MUST record the approval in Postgres (`finny_approval_requests`).
  - Core's runtime coordinator MUST automatically trigger `afterApproved()`, dispatching the Producer and Auditor subagents.
- **R4:** The Web UI MUST render structured Generative UI cards (KPI callouts, metric badges, and tables) natively via client-side components without requiring `THESYS_API_KEY` or external cloud services.
- **R5:** Zero modifications or regressions to Slack Block Kit card delivery (`src/slack/*`).

### Scope Boundaries

- **In Scope:**
  - `src/agent/agent-tools/finny.ts`: Rich approval metadata preservation on web turns.
  - `src/api/routes/turns.ts` / `src/core/orchestrator.ts`: Hooking Web approval submission to `FinnyApprovalBridge`.
  - `plugins/web-ui/src/composer.ts`, `plugins/web-ui/src/chat.ts`, `plugins/web-ui/src/shell.css`: Dedicated Finny Plan Card UI component.
  - `plugins/web-ui/server/index.ts`: Card presentation gateway instructions for Web turns.
- **Out of Scope (Deferred):**
  - Standalone Next.js `openui-agent` scaffold (exploratory only; not bundled into core).
  - External cloud hosting or Thesys Gateway proxy integration.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 (Native Web Lit Component for Finny Plan Cards):** Rather than loading external iframes or Next.js wrappers, implement a dedicated `<finny-plan-card>` or `finnyPlanCardView` template in `plugins/web-ui/src/chat.ts` and `composer.ts` styled with QM's native CSS tokens (`--surface`, `--border`, `--cta`, `--destructive`). (session-settled: user-directed — chosen over heavy Next.js embed: retains desktop performance, zero bundle bloat). Governs R2.
- **KTD2 (Finny Approval Bridge Hook in Core Turn Intake):** When `/api/approvals/:requestId` or Core's orchestrator receives `input.approval` matching `kind: "approval"` with `approvalReason: "Finny Governance Plan Approval"`, Core checks for a matching pending Finny plan request and calls `deps.finnyApprovals.decide(...)`. This guarantees that web approvals unlock the exact same subagent dispatch loop as Slack approvals. Governs R3.
- **KTD3 (Rich Metadata Preservation in Tool Context):** Update `finnyTools` in `src/agent/agent-tools/finny.ts` to attach `summaryDetail: JSON.stringify({ plan: params.plan, clarification: params.materialClarification })` and `approvalKey: 'finny-plan:' + jobId` to `NeedsApproval`. Core passes this through to `PendingApproval` so `fetchSessionApprovals` delivers full card data to the frontend. Governs R1.
- **KTD4 (Client-Side Generative UI Blocks):** Use QM's existing `StableMarkdown` custom element pipeline in `plugins/web-ui/src/stable-markdown.ts` to render fenced card blocks (`generative-ui.v1` / `json-render` / `openui`) into responsive Lit components. Governs R4.

---

## Implementation Units

### U1. Core Payload Preservation & Approval Bridge Wiring

- **Goal:** Preserve rich plan presentation metadata on Web turns and wire Web approval decisions into `FinnyApprovalBridge`.
- **Files:**
  - `src/agent/agent-tools/finny.ts`
  - `src/core/orchestrator.ts`
  - `src/api/routes/turns.ts`
  - `test/finny-agent-tool.test.ts`
- **Approach:**
  - In `src/agent/agent-tools/finny.ts`:
    - On `opts?.surfaceName === "web"`, pass `params.plan` and `params.materialClarification` as structured JSON inside `e.matched` or `summaryDetail`.
  - In `src/core/orchestrator.ts` (`input.approval` processing):
    - If the approval's reason is `"Finny Governance Plan Approval"`, lookup the pending Finny approval request and execute `deps.finnyApprovals.decide({ requestId, decision: { kind: "plan", action: input.approval.approved ? "approve" : "reject" }, actor })`.
- **Verification:** `node --test test/finny-agent-tool.test.ts`

### U2. Web UI Interactive Finny Plan Card Component

- **Goal:** Render a structured governance card in Web Chat and Composer with full phase details and action buttons.
- **Files:**
  - `plugins/web-ui/src/conv-types.ts`
  - `plugins/web-ui/src/chat.ts`
  - `plugins/web-ui/src/composer.ts`
  - `plugins/web-ui/src/shell.css`
  - `plugins/web-ui/test/approval-blocks-input.test.ts`
- **Approach:**
  - In `conv-types.ts`: Extend `PendingApproval` with optional `finnyPlan?: FinnyPlanPresentation`.
  - In `chat.ts`: Add `renderFinnyPlanCard(approval)` rendering:
    - Title banner and badge `Finny Plan Approval`.
    - Collapsible phase timeline with owner badges.
    - Deliverable and Certification notes.
    - Action buttons: `Approve`, `Reject`, and `Request Change`.
  - In `composer.ts`: Wire button clicks to `ctx.chat.resolveCommandApproval`.
- **Verification:** `npm --prefix plugins/web-ui test`

### U3. Web Gateway Presentation Context & Generative UI Cards

- **Goal:** Instruct models on Web turns to emit structured summary cards and render them via client-side Lit components.
- **Files:**
  - `plugins/web-ui/server/index.ts`
  - `plugins/web-ui/src/stable-markdown.ts`
  - `plugins/web-ui/test/stable-markdown.test.ts`
- **Approach:**
  - In `plugins/web-ui/server/index.ts`: In `webTurnBase()`, inject card layout rules into `conversationHeader` for analytical/financial turns.
  - In `plugins/web-ui/src/stable-markdown.ts`: Parse card blocks and render compact metric badges, callout cards, and clean data tables.
- **Verification:** `npm --prefix plugins/web-ui test`

---

## Verification Contract

1. **Unit & Integration Suite:**
   - `node --test test/finny-agent-tool.test.ts`
   - `npm --prefix plugins/web-ui test`
   - `npm run typecheck`
2. **Slack Non-Regression Gate:**
   - `node --test test/slack-finny-cards.test.ts` (Ensures zero changes to Slack Block Kit cards).
3. **End-to-End Simulation:**
   - Exercise Web Chat with a reconciliation prompt; verify interactive plan card mounts with "Approve" button, clicking "Approve" advances turn without stalling, and output renders as a styled card.

---

## Definition of Done

- [ ] `finny_create_plan` renders an interactive plan card in the QM Web Chat.
- [ ] Operator clicking "Approve" triggers `FinnyApprovalBridge.decide()`, records the approval event, and wakes the subagent coordinator.
- [ ] Generative UI metrics and summary tables render client-side without any `THESYS_API_KEY`.
- [ ] Slack cards, Block Kit logic, and Slack tests remain 100% untouched.
- [ ] Full repo typecheck and tests pass cleanly.
