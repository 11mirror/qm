# Audit & Gap Note: QM Web/Desktop App Missing UI Cards & Finny Plan Approvals

## 1. Background & Context

The user observed in the QM desktop/web app that when Finny creates a financial plan (e.g. `finny_create_plan`), the UI does not render interactive cards with action buttons (Approve / Reject / Clarification options). Instead, the model outputs raw text (e.g. `Finny create_plan`, `Please approve the reconciliation plan...`) without any interactive card widget.

## 2. Upstream Source vs. Fork Investigation

We investigated upstream (`yc-software/qm`) vs our local repository (`11mirror/qm`):

1. **Upstream Source (`yc-software/qm`)**:
   - Upstream QM does **not** have Finny or Generative UI cards.
   - Upstream core only has standard shell command approvals (`NeedsApproval` for CLI bash commands, sandboxes, keychains).
   - In upstream, approvals appear as `.composer-approval-panel` docked above the composer textarea with buttons "Deny", "Allow once", "Allow for session", and "Allow always".
   - There are no card components upstream for custom tools, plan presentations, or structured generative UI.

2. **Downstream Fork (`11mirror/qm`) & Prior Commits**:
   - `src/slack/finny-cards.ts`, `src/slack/finny-approvals.ts`, and `src/slack/generative-ui.ts` implemented rich Slack Block Kit cards (`finnyPlanCard`, `finnyClarificationCard`, `finnyJobStatusCard`, `@json-render/chat`).
   - All card rendering logic was implemented **only** for Slack Block Kit in `src/slack/`.
   - In PR #31 (`bc2af7cbc`), an attempt was made in `src/agent/agent-tools/finny.ts`:
     ```ts
     if (opts?.surfaceName === "web") {
       return blockOnApproval(
         callId,
         {
           name: "NeedsApproval",
           message: result,
           command: params.plan.title,
           approvalReason: "Finny Governance Plan Approval",
           kind: "approval",
           grantModes: { session: false, always: false },
         },
         params.plan.summary,
         { tool: "finny", action: "create_plan", title: params.plan.title },
       );
     }
     ```
   - On the web UI, `blockOnApproval` pauses the turn and emits a standard `NeedsApproval` event.

## 3. Root Cause Analysis (Why Cards Are Not Showing)

### Gap A: Missing Card / Interactive Plan Component in Web UI

- The web UI (`plugins/web-ui`) has no renderer for Finny plan cards or Generative UI cards.
- The web UI's `composerApprovalPanel` (`plugins/web-ui/src/composer.ts:937`) was built solely for command approvals (`Allow once`, `Allow for session`, `Deny`).
- When `finny_create_plan` triggers `NeedsApproval`, it only contains:
  - `command: params.plan.title`
  - `reason: "Finny Governance Plan Approval"`
  - `grantModes: { session: false, always: false }`
- The rich plan payload (`phases`, `certification`, `deliverable`, `destination`, `clarifications`, or `materialClarification` options) is completely discarded and never passed to the web frontend!

### Gap B: Model Emits Plan as Plain Text Without Card Framing

- In `src/slack/turn-handler.ts`, Slack injects `SLACK_CARD_INSTRUCTION` into `gatewayContext.instructions`.
- In `plugins/web-ui/server/index.ts`, the web surface does **not** inject any card presentation instructions.
- The model on web turns is never instructed on how to structure an interactive card or OpenUI/json-render component, so it outputs plain Markdown text.

### Gap C: Decoupled Finny Approval Service vs. Web Approval Endpoint

- When clicking "Approve" in Slack, Slack sends an interactive action event to `registerFinnyApprovalActions` which calls `finnyApprovals.decide(...)`.
- `finnyApprovals.decide` updates the Postgres store `finny_approval_requests` and triggers `afterApproved`, which notifies the runtime coordinator to spawn the Producer and Auditor subagents.
- On Web, `composer.ts` submits decisions to `/api/approvals/:requestId` -> `/v1/turns` with `approval: { requestId, approved }`.
- Core's turn orchestrator receives `input.approval` and deletes from `pendingApprovals` table, but **never** invokes `finnyApprovals.decide(...)` or `coordinator.afterApproved(...)`. As a result, approving on web leaves the Finny job stuck in `awaiting_approval` without waking the Producer or Auditor!

## 4. Architectural Solution Overview

To support interactive cards in the QM web app without touching Slack:

1. **Web Finny Plan Approval Component in Web UI (`plugins/web-ui`)**:
   - Provide a specialized approval card component in `plugins/web-ui/src/` (or extend `composerApprovalPanel` / `StableMarkdown`) that renders Finny plan metadata (Title, Summary, Phases, Deliverable, Certification, Material Clarifications).
   - Display action buttons: "Approve Plan", "Reject", "Request Change" (matching the Slack semantics).
2. **Expose Full Plan Payload to Core Approvals**:
   - In `src/agent/agent-tools/finny.ts`, when pausing on web, attach the structured plan presentation and material clarification to `ref.pendingApprovals` (or pass it in `summaryDetail` / payload) so `app.listSessionApprovals` delivers the full card data to the web frontend.
3. **Bridge Web Approval Decision to `FinnyApprovalBridge`**:
   - When `/api/approvals/:requestId` receives an approval for a `Finny Governance Plan Approval`, core must call `finnyApprovals.decide(...)` so the Finny store transitions to `approved` and dispatches the worker agents.
4. **Presentation Instructions in Web Turn Context**:
   - Inject structured card / component instructions into `webTurnBase` or orchestrator so the web surface receives properly framed cards.
