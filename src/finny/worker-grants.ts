import { createHash, randomUUID } from "node:crypto";
import { mintSignedPayload } from "../auth/signed-token.ts";
import { FINNY_CHECK_IDS } from "./policy.ts";
import type { FinnyStore } from "./store.ts";
import type { FinnyPolicySnapshot, FinnyWorkerGrant, FinnyWorkerGrantPayload, FinnyWorkerRole } from "./types.ts";

export interface IssueFinnyWorkerInput {
  scopeId: string;
  jobId: string;
  principalId: string;
  runId: string;
  expiresAt: number;
}

function policyDigest(policy: FinnyPolicySnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: policy.policyVersion,
        requiredGenerations: Object.fromEntries(
          FINNY_CHECK_IDS.map((checkId) => [checkId, policy.requiredGenerations[checkId]]),
        ),
      }),
    )
    .digest("base64url");
}

function stringField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createFinnyWorkerGrants(store: FinnyStore, secret: string, now: () => number = Date.now) {
  function validateInput(input: IssueFinnyWorkerInput): void {
    if (!stringField(input.principalId) || !stringField(input.runId)) {
      throw new Error("Finny worker run and principal must be non-empty");
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now()) {
      throw new Error("Finny worker grant expiry is invalid");
    }
  }

  async function issue(input: IssueFinnyWorkerInput, role: FinnyWorkerRole): Promise<FinnyWorkerGrant> {
    validateInput(input);
    const job = await store.getJob(input.scopeId, input.jobId);
    if (!job) throw new Error("Finny job was not found in this scope");
    if (job.approval?.action !== "approve" || job.approval.consumedAt !== undefined) {
      throw new Error("Finny job is not approved for worker dispatch");
    }
    if (role === "auditor" && !job.artifactDigest) {
      throw new Error("Finny Auditor grant requires a current artifact");
    }
    await store.claimWorkerRun({ scopeId: input.scopeId, jobId: input.jobId, runId: input.runId, role });
    const payload: FinnyWorkerGrantPayload = {
      aud: "finny.worker",
      jti: randomUUID(),
      scopeId: input.scopeId,
      jobId: input.jobId,
      principalId: input.principalId,
      role,
      runId: input.runId,
      ...(job.artifactDigest ? { artifactDigest: job.artifactDigest } : {}),
      policyDigest: policyDigest(job.policy),
      allowedChecks: role === "auditor" ? [...FINNY_CHECK_IDS] : [],
      issuedAt: now(),
      expiresAt: input.expiresAt,
    };
    return { payload, token: await mintSignedPayload(payload, secret) };
  }

  return {
    issueProducer: (input: IssueFinnyWorkerInput) => issue(input, "producer"),
    issueAuditor: (input: IssueFinnyWorkerInput) => issue(input, "auditor"),
  };
}
