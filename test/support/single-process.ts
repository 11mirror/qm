import { createApprovalRecords } from "../../src/core/approval-store.ts";
import { createApprovalGrants } from "../../src/core/orchestrator/approvals.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { createMemoryBlobTransferStore, createNoopAdvisoryLock, createNoopLeaderLease } from "./in-process-stores.ts";

export const singleProcessDeps = (url = testDatabaseUrl()) => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: createApprovalRecords(url),
  approvalGrants: createApprovalGrants(url),
  blobTransfer: createMemoryBlobTransferStore(),
});
