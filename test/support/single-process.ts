import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createNoopLeaderLease } from "../../src/persistence/leader-lease.ts";
import { createMemoryBlobTransferStore } from "../../src/persistence/blob-transfer.ts";
import { createApprovalGrants, createApprovalRecords } from "../../src/core/approval-store.ts";
import { testDatabaseUrl } from "./test-database.ts";

export const singleProcessDeps = (url = testDatabaseUrl()) => ({
  advisoryLock: createNoopAdvisoryLock(),
  leaderLease: createNoopLeaderLease(),
  approvals: createApprovalRecords(url),
  approvalGrants: createApprovalGrants(url),
  blobTransfer: createMemoryBlobTransferStore(),
});
