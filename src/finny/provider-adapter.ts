import type { AtomicFetchAdapter, FinnyAdvisoryEnrichment } from "./credential-brokered-finance-service.ts";
import { isDeepStrictEqual } from "node:util";
import { selectFinnyVerificationPolicy } from "./accounting-validator.ts";
import { isReviewedFinnyQuery } from "./capability-registry.ts";
import { digestFinnyEvidence } from "./golden-loop.ts";
import {
  FinanceFailure,
  financeFailureWithDiagnostic,
  type FinanceDiagnosticSink,
  type FinanceFailureMetadata,
} from "./finance-failure.ts";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import type { FinnyOperationRow } from "./operation-executor.ts";
import type { FinnyOperationRunnerInput } from "./operation-runner.ts";
import { finnyApprovalPolicyDigest } from "./finance.ts";

export interface FinnyHindsightCredential {
  apiUrl: string;
  apiKey: string;
  bankIds: readonly string[];
}

export interface FinnyNetSuiteCredential {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

export interface FinnyHindsightClient {
  recall(query: string, credential: FinnyHindsightCredential): Promise<unknown>;
}

export interface FinnyNetSuiteClient {
  suiteql(query: string, credential: FinnyNetSuiteCredential): Promise<readonly unknown[]>;
}

export interface FinnyAtomicFetchClients {
  hindsight: FinnyHindsightClient;
  netsuite: FinnyNetSuiteClient;
  diagnostics?: FinanceDiagnosticSink;
}

export interface FinnyNetSuiteOperationExecutorInput {
  plan: FinnyOperationPlan;
  credential: FinnyNetSuiteCredential;
  client: FinnyNetSuiteClient;
}

export function createFinnyNetSuiteOperationExecutor({
  plan,
  credential,
  client,
}: FinnyNetSuiteOperationExecutorInput): FinnyOperationRunnerInput["executeExternal"] {
  const operations = new Map(plan.operations.map((operation) => [operation.id, operation]));
  if (operations.size !== plan.operations.length) throw new Error("Finny operation plan contains duplicate identities");

  return async ({ operation }) => {
    const reviewed = operations.get(operation.id);
    if (!reviewed) throw new Error(`Finny operation ${operation.id} does not belong to the compiled plan`);
    if (!isDeepStrictEqual(operation, reviewed))
      throw new Error(`Finny operation ${operation.id} does not match its compiled plan identity`);

    let query: string;
    if (reviewed.primitive === "suiteql_select") {
      query = reviewed.sql;
    } else if (reviewed.primitive === "repeat_pull") {
      const repeated = operations.get(reviewed.operationId);
      if (!repeated || repeated.primitive !== "suiteql_select" || !reviewed.dependsOn.includes(repeated.id))
        throw new Error(`Finny repeat operation ${reviewed.id} has an invalid reviewed SuiteQL reference`);
      query = repeated.sql;
    } else {
      throw new Error(`Finny derived operation ${reviewed.id} cannot execute through NetSuite`);
    }

    const rows = await client.suiteql(query, credential);
    if (!Array.isArray(rows)) throw new Error(`Finny operation ${reviewed.id} result must be an array`);
    return rows as readonly FinnyOperationRow[];
  };
}

export function createFinnyAtomicFetchAdapter(clients: FinnyAtomicFetchClients) {
  return {
    async preflightPlan(input, context, credentials) {
      const enrichment = await advisoryEnrichment(
        input.request,
        credentials.hindsight,
        clients.hindsight,
        context,
        clients.diagnostics,
        credentials.hindsightFailure,
      );
      const approvalPolicyDigest = finnyApprovalPolicyDigest(input.plan);
      const evidence = JSON.stringify({
        runId: context.runId,
        actorId: context.actorId,
        request: input.request,
        clarificationDigest: input.clarificationDigest,
        plan: input.plan,
        approvalPolicyDigest,
        enrichment,
        access: "read-only",
      });
      return {
        planSummary:
          enrichment.state === "available"
            ? "Reviewed operation plan with advisory Hindsight enrichment and brokered NetSuite execution."
            : "Reviewed operation plan with brokered NetSuite execution; optional Hindsight enrichment omitted.",
        preflightDigest: digestFinnyEvidence(`operation-plan-preflight:${evidence}`),
        approvalRequired: input.plan.approvalPolicy.mode !== "none",
        approvalPolicyDigest,
        enrichment,
      };
    },
    async executeOperation(input, _context, credentials) {
      const execute = createFinnyNetSuiteOperationExecutor({
        plan: input.plan,
        credential: netsuiteCredential(credentials.netsuite),
        client: clients.netsuite,
      });
      return { rows: await execute(input.execution) };
    },
    async preflight(input, context, credentials) {
      const enrichment = await advisoryEnrichment(
        input.request,
        credentials.hindsight,
        clients.hindsight,
        context,
        clients.diagnostics,
        credentials.hindsightFailure,
      );
      const evidence = JSON.stringify({
        runId: context.runId,
        actorId: context.actorId,
        request: input.request,
        query: input.query,
        clarificationDigest: input.clarificationDigest,
        enrichment,
        access: "read-only",
      });
      return {
        planSummary:
          enrichment.state === "available"
            ? "Read-only Hindsight enrichment followed by a reviewed NetSuite SuiteQL source query."
            : "Reviewed read-only NetSuite SuiteQL source query; optional Hindsight enrichment omitted.",
        preflightDigest: digestFinnyEvidence(`preflight:${evidence}`),
        planDigest: digestFinnyEvidence(`plan:${evidence}`),
        approvalRequired: true,
        verificationPolicy: selectFinnyVerificationPolicy(context.requestText ?? input.request),
        enrichment,
      };
    },
    async source(input, context, credentials) {
      const query = input.query;
      if (!query) throw new Error("Approved SuiteQL query is unavailable");
      assertReadOnlySuiteQl(query);
      const netsuite = netsuiteCredential(credentials.netsuite);
      const [enrichment, records] = await Promise.all([
        advisoryEnrichment(
          query,
          credentials.hindsight,
          clients.hindsight,
          context,
          clients.diagnostics,
          credentials.hindsightFailure,
        ),
        clients.netsuite.suiteql(query, netsuite),
      ]);
      if (!Array.isArray(records)) throw new Error("NetSuite result is invalid");
      const evidence = JSON.stringify({
        runId: context.runId,
        actorId: context.actorId,
        planDigest: input.planDigest,
        queryDigest: digestFinnyEvidence(query),
        enrichment,
        records,
      });
      return { records, sourceDigest: digestFinnyEvidence(evidence), enrichment };
    },
  } satisfies AtomicFetchAdapter;
}

async function advisoryEnrichment(
  query: string,
  secret: string | undefined,
  client: FinnyHindsightClient,
  context: { runId: string },
  diagnostics?: FinanceDiagnosticSink,
  credentialFailure?: FinanceFailureMetadata,
): Promise<FinnyAdvisoryEnrichment> {
  if (!secret)
    return {
      provider: "hindsight",
      state: "omitted",
      reason: "credential_unavailable",
      ...(credentialFailure ? { failure: credentialFailure } : {}),
    };
  try {
    const credential = hindsightCredential(secret);
    const recalled = await client.recall(query, credential);
    return {
      provider: "hindsight",
      state: "available",
      evidenceDigest: digestFinnyEvidence(evidenceJson(recalled, "Hindsight evidence")),
    };
  } catch (error) {
    if (!diagnostics && !(error instanceof FinanceFailure))
      return { provider: "hindsight", state: "omitted", reason: "provider_unavailable" };
    const failure = financeFailureWithDiagnostic(error, {
      runId: context.runId,
      operation: "hindsight recall",
      cause: "provider_unavailable",
      retryable: true,
      dependency: "hindsight",
      diagnostics,
    });
    return {
      provider: "hindsight",
      state: "omitted",
      reason: "provider_unavailable",
      failure: failure.toSafeMetadata(),
    };
  }
}

export function assertReadOnlySuiteQl(query: string): void {
  if (!isReviewedFinnyQuery(query)) throw new Error("Only an exact reviewed read-only SuiteQL query is allowed");
}

function hindsightCredential(secret: string): FinnyHindsightCredential {
  const value = objectFromSecret(secret, "Hindsight");
  const apiUrl = requiredText(value.apiUrl, "Hindsight");
  const apiKey = requiredText(value.apiKey, "Hindsight");
  const bankIds = Array.isArray(value.bankIds) ? value.bankIds : [];
  if (!bankIds.length || !bankIds.every((bankId) => typeof bankId === "string" && bankId.trim().length > 0)) {
    invalidCredential("Hindsight");
  }
  const url = safeUrl(apiUrl, "Hindsight");
  const renderedUrl = url.toString();
  return {
    apiUrl: renderedUrl.endsWith("/") ? renderedUrl.slice(0, -1) : renderedUrl,
    apiKey,
    bankIds: bankIds.map((bankId) => bankId.trim()),
  };
}

function netsuiteCredential(secret: string): FinnyNetSuiteCredential {
  const value = objectFromSecret(secret, "NetSuite");
  return {
    accountId: requiredText(value.accountId, "NetSuite"),
    consumerKey: requiredText(value.consumerKey, "NetSuite"),
    consumerSecret: requiredText(value.consumerSecret, "NetSuite"),
    tokenId: requiredText(value.tokenId, "NetSuite"),
    tokenSecret: requiredText(value.tokenSecret, "NetSuite"),
  };
}

function objectFromSecret(secret: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(secret);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    return invalidCredential(name);
  }
  return invalidCredential(name);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return invalidCredential(name);
}

function safeUrl(value: string, name: string): URL {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password)
      return url;
  } catch {
    return invalidCredential(name);
  }
  return invalidCredential(name);
}

function evidenceJson(value: unknown, name: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch {
    throw new Error(`${name} is invalid`);
  }
  throw new Error(`${name} is invalid`);
}

function invalidCredential(name: string): never {
  throw new Error(`${name} credential bundle is invalid`);
}
