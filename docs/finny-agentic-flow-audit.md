# The Agentic Flow of Finny Harness & Architecture Audit

## 1. Executive Summary

This evaluation audits the Finny agentic harness in QM to determine:

1. What the intended "Golden Loop" and delegation architecture was designed to be (`job_book`, multi-agent Producer-Auditor separation, subagents, and governance).
2. What is currently present in the codebase.
3. Why the agent currently executes everything as a single agent instead of dispatching to an agentic team.

---

## 2. The Intended "Golden Loop" Architecture

Based on the FinnyLoop specifications (`skills-seed/finnyloop/SKILL.md`, `candidate-finnyloop-r1` in PostgreSQL, and design records in `docs/plans/`):

```
                     ┌───────────────────────────────┐
                     │ User Request (Slack / Web)    │
                     └───────────────┬───────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │  Phase 1: Intake & Resolver   │
                     │  - resolver.md Intent Map     │
                     │  - Invariant binding          │
                     └───────────────┬───────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │  Phase 2: Preflight Plan Card │
                     │  - finny_create_plan          │
                     │  - Human Approval via Card    │
                     └───────────────┬───────────────┘
                                     │ [Approved]
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Phase 3: Multi-Agent Coordinator & Job State              │
│                  Authoritative Store (`finny_jobs`)                    │
└──────────────────┬──────────────────────────────────┬──────────────────┘
                   │                                  │
                   ▼ (Dispatches)                     ▼ (Dispatches)
     ┌───────────────────────────┐      ┌───────────────────────────┐
     │      Finny Producer       │      │       Finny Auditor       │
     │      (Worker Subagent)    │      │     (Independent Agent)   │
     │ - Extract NetSuite data   │      │ - Awaits artifactDigest   │
     │ - OpenPyXL workbook build │      │ - Runs deterministic audit│
     │ - Uploads artifact        │      │ - Evaluates policy checks │
     │ - finny_artifact_ready    │─────►│ - Calls finny_pass/block  │
     └───────────────────────────┘      └─────────────┬─────────────┘
                                                      │
                       ┌──────────────────────────────┴──────────┐
                       │                                         │
                   [On PASS]                                 [On BLOCK]
                       ▼                                         ▼
         ┌───────────────────────────┐             ┌───────────────────────────┐
         │       Finalizer           │             │      Rework Loop          │
         │ - Authoritative receipt   │             │ - Increments generation   │
         │ - Deliverable to Slack/Web│             │ - Wakes Producer          │
         └───────────────────────────┘             └───────────────────────────┘
```

### Intended Control Plane:

1. **The `job_book` / Job State Invariant**:
   - Every financial run is backed by an append-only state ledger (`finny_jobs`, `finny_job_events`, `finny_worker_runs`).
   - Read before action, write after step.
2. **Strict Separation of Roles**:
   - **Parent / Coordinator**: Talks to the human, gathers requirements, presents the plan card, and never touches raw calculations or data directly.
   - **Producer Subagent**: Spawns in isolation with NetSuite / calculation tools, produces the artifact, and registers its digest.
   - **Auditor Subagent**: Runs independently from the Producer. Inspects only the compiled artifact digest and runs deterministic formula checks and invariant validations.

---

## 3. What Is Currently in the Codebase

### A. The Core Finny Engine (`src/finny/`)

The underlying server infrastructure is **fully built and robust**:

- `src/finny/runtime-coordinator.ts`: Implements `afterApproved()`, which creates role-bound sessions for **Finny Producer** (`startupKey:producer`) and **Finny Auditor** (`startupKey:auditor`).
- `src/finny/worker-grants.ts`: Issues distinct, role-bound HMAC grants (`producer` vs `auditor`) and prevents cross-role privilege escalation.
- `src/finny/deterministic-spreadsheet-worker.ts`: Runs LibreOffice Calc / formula recalculation and summary crossfooting.
- `src/finny/postgres-store.ts`: Implements the complete state store (`finny_jobs`, `finny_approval_requests`, `finny_attestations`, `finny_job_events`).

### B. What was Called `job_board` / `job_book`

In earlier prototypes (`candidate-finnyloop-r1`), the concept was documented as a text-based `job_book` in markdown or skills. In the production implementation, this was codified into the **PostgreSQL relational tables**:

- `finny_jobs`: The master state card (plan digest, status, approval state, artifact digest, receipt).
- `finny_job_events`: The ordered append-only ledger of state transitions (`plan_created`, `approved`, `artifact_ready`, `audit_passed`, `audit_blocked`).
- `finny_worker_runs`: Tracking of active worker sessions and bindings.

---

## 4. Why the Agent Ends Up Executing Alone (Root Cause Analysis)

Despite the backend having the coordinator and worker spawners, in live sessions **the agent executes alone inline**. Here is why:

### Cause 1: Feature Flag `responsive_spine` Disables Mandatory Delegation

In `src/core/orchestrator.ts:516` and `src/sessions/session-syscalls.ts:50`:

```ts
const delegationEnabled = !external && actorFeatures.has("responsive_spine");
const delegateWork = requiresDelegation(input, delegationEnabled);
```

- In database table `feature_flags`, only `persistent_subagents` is enabled for users. **`responsive_spine` is NOT enabled**.
- When `delegateWork` is `false`, QM gives the parent agent direct access to `execute` (bash/terminal) and sandbox tools.
- Because the parent agent has direct execution capabilities, the LLM takes the path of least resistance: it writes code and runs calculations **directly inline** rather than initiating the multi-agent delegation sequence.

### Cause 2: FinnyLoop Preflight Was Hardcoded to Slack Cards

In `src/core/orchestrator.ts:2586` and `src/finny/integration.ts:139`:

- `finnyTools` (the tool factory providing `finny_create_plan`) was gated strictly by `surface === "slack"`.
- When in Web Chat (or when Slack wasn't detected), `finny_create_plan` was stripped from the toolset.
- Even in Slack, if the query did not match exact acronym keywords (`\bap\b`, `\bar\b`, `\bgl\b`), the orchestrator skipped injecting the FinnyLoop governance directive.

### Cause 3: Subagent Spawning via `runtime-coordinator` Relies on Webhook / Bus Wakes

In `src/wiring.ts` and `src/finny/runtime-coordinator.ts`:

- The Producer and Auditor subagents are designed to be created via `deps.sessions.open()` **after** the human operator clicks **Approve** on the `finny_create_plan` card.
- If the plan card is never emitted or approved (because the parent agent skips `finny_create_plan` and computes the numbers directly), the approval trigger never fires, and the runtime coordinator never spawns the Producer/Auditor subagent team.

---

## 5. Audit Matrix: Planned vs. Live

| Component               | Planned (Golden Loop)                              | Currently in Codebase                                      | Live Operational Status                                 | Root Gap                                                 |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| **Intent Classifier**   | Fast sub-1s decomposer with skill awareness        | Regex keyword lists + recently added async fast-decomposer | Working for expanded keywords; needed async LLM routing | Keyword fragility bypassed FinnyLoop                     |
| **Plan Approval Card**  | Interactive card in any surface (Slack & Web)      | Slack Block Kit card handler; Web bridge just wired        | Live on Slack & Web                                     | Previously dropped on Web Chat                           |
| **`job_book` / Ledger** | Append-only state ledger                           | PostgreSQL `finny_jobs` + `finny_job_events`               | 100% functional in DB                                   | Fully backed by Postgres; not a text file                |
| **Producer Subagent**   | Role-bound worker for SuiteQL & OpenPyXL           | Built in `runtime-coordinator.ts`                          | Stalled if approval skipped                             | Triggered only via approval event                        |
| **Auditor Subagent**    | Independent agent running formula/crossfoot checks | Built in `runtime-coordinator.ts` + deterministic worker   | Functional when dispatched                              | Dependent on Producer artifact event                     |
| **Agentic Delegation**  | Parent coordinates, delegates all work             | Gated behind `responsive_spine` flag                       | Parent executes inline                                  | `responsive_spine` disabled; parent holds `execute` tool |

---

## 6. Recommendations to Restore Full Agentic Team Flow

1. **Enforce Delegation on Finance Turns**:
   When `isFinanceTurn` is true, remove direct sandbox execution from the parent agent or set `delegateWork = true` for the turn, forcing the parent agent to only plan, coordinate, and delegate.
2. **Automate Preflight Plan Triggering**:
   Require `finny_create_plan` before any NetSuite query or financial spreadsheet tool can be called.
3. **Bridge Job Book Transparency to Chat**:
   Expose an inline visual status card showing the state of `finny_jobs` (e.g. `[JobBook: Plan Approved -> Producer Building -> Auditor Verifying]`) so the user can see the agentic team handing off tasks in real time.
