# Post-Run Audit: Finny Agentic Delegation, JobBook State, and UI Rendering

**Date:** 2026-11-14  
**Job ID:** `4ac456cb-37a2-411a-9378-f30ac0b4e305`  
**User Thread:** `D0CFQ3FP3NJ:1794664499.789489`  
**Run Analyzed:** Slack run resulting in attached `.xlsx` and `.html` files, followed by auditor block and escalation.

---

## 1. Did the Golden Loop get followed? (Agentic Delegation & `finny_jobs` ledger)

### Verdict: **YES — Multi-Agent Delegation and the Durable Event Ledger ran end-to-end.**

The PostgreSQL database records prove that the agentic loop was followed across independent subagents:

1. **Plan Registration & Approval**:
   - `finny_jobs` record was created with title: _"Weekly Net Pay Run — vendor payment list (NetSuite + external holds)"_.
   - Operator clicked **Approve** (`approval_action: approve`), writing approval metadata into `finny_jobs`.

2. **Automated Multi-Agent Spawning**:
   Upon approval, `runtime-coordinator` automatically spawned two distinct, role-bound subagents:
   - **Finny Producer** (`session de6ae9d1`, `run 05c4b712`): Bound to role `producer`. It queried NetSuite, extracted 218 vendor bills, and compiled `net_pay_2026-11-14.xlsx` and `net_pay_2026-11-14.html`.
   - **Finny Auditor** (`session a4f2a002`, `run 43adea71`): Bound to role `auditor`. Ran independently to verify the Producer's artifact.

3. **Subagent Event Ledger Discipline (`finny_job_events`)**:
   Each subagent wrote its step outcomes into the append-only `finny_job_events` ledger:
   - `seq 148`: `artifact_ready` (Producer uploaded workbook digest `9ceba8cdb...`).
   - `seq 149`: `audit_passed` (Auditor passed `formula.recalculate` at generation 1).
   - `seq 150`: `audit_blocked` (Auditor caught `CROSSFOOT_MISMATCH` on blended currency totals).
   - `seq 151`: `rework_requested` (System incremented generation to 2 and woke Producer).
   - `seq 152`–`159`: Producer attempted 3 reworks, uploading revisions `ff559ef...`, `d593434...`, and `bc0f1b2...`.
   - `seq 162`: `audit_blocked` (Auditor persistently blocked `summary.crossfoot` because blended currencies remained in total rows).
   - `seq 163`: `escalated` (`{"reason": "Finny reached the configured 3 BLOCK limit"}`).

The multi-agent separation worked as intended: **The Producer could not self-certify its own workbook, and the independent Auditor repeatedly blocked delivery because multi-currency totals were mathematically inconsistent.**

---

## 2. Why is the Render JSON UI / Visual Card Broken on Audit Failure?

In Image #3, the escalation appeared as plain text:

> _"Finny job 4ac456cb-37a2-411a-9378-f30ac0b4e305 reached its configured rework limit and requires human review."_

Instead of a rich Block Kit card with visual ticks/crosses and fresh working status, it degraded to plain text. Here is why:

### Root Cause 1: Raw String Delivery on Escalation (`src/wiring.ts:2348-2352`)

In `src/wiring.ts`:

```ts
const deliverEscalation = async (job) => {
  await deliveries.enqueue({
    destination: parent.destination,
    text: `Finny job ${job.id} reached its configured rework limit and requires human review.`,
    idempotencyKey: `finny-escalation:${job.id}:${job.unresolvedEscalationSequence}`,
  });
};
```

When a job hits its rework limit or is blocked, `deliverEscalation` enqueues a **raw text string** instead of assembling a `finnyJobStatusCard` or `finnyResultCard`.

### Root Cause 2: Intermediary Progress Events Did Not Enqueue Thread Deliveries

While `runtime-coordinator.ts` correctly updated internal event sequences in PostgreSQL (`rework_requested`, `audit_blocked`), it did not have an active delivery hook to push intermediate visual cards into the Slack thread during the background rework loop.

### Root Cause 3: Deliverables Were Uploaded Before Final Certification

The coordinator posted the draft `.html` and `.xlsx` attachments into the thread accompanied by conversational commentary (_"Built and attached — but read the gap before you circulate it"_). Because the independent audit subsequently failed on crossfoot, the user was left holding provisional files that were not certified.

---

## 3. Concrete Action Items to Address These Observations

1. **Replace Raw String in `deliverEscalation`**:
   Update `src/wiring.ts:2348` to construct a `finnyJobStatusCard` with `stage: "audit_blocked"` and `FinnyResultCard` displaying explicit red crosses (`:x:`) for failed crossfoot checks, rather than sending a raw text notice.
2. **Real-time Event Broadcaster**:
   In `src/finny/runtime-coordinator.ts`, whenever `rework_requested` or `artifact_ready` occurs, enqueue a thread update delivery using `finnyJobStatusCard` so the user sees `[⚙️ Producer: Reworking]` and `[🔍 Auditor: Verifying]` live.
3. **Withhold Slack File Attachment Until Final Receipt**:
   Ensure `uploadAttachments` strictly withholds `.xlsx`/`.html` attachments from the human thread if the active job is still in `rework_requested` or `audit_blocked` state, only releasing them once `finny_finalize` mints an approved final receipt.
