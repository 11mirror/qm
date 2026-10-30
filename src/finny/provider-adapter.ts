import type { AtomicFetchAdapter } from "./credential-brokered-finance-service.ts";
import { isDeepStrictEqual } from "node:util";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import type { FinnyOperationRow } from "./operation-executor.ts";
import type { FinnyOperationRunnerInput } from "./operation-runner.ts";

export interface FinnyNetSuiteCredential {
  accountId: string;
  consumerKey: string;
  consumerSecret: string;
  tokenId: string;
  tokenSecret: string;
}

export interface FinnyNetSuiteClient {
  suiteql(query: string, credential: FinnyNetSuiteCredential): Promise<readonly unknown[]>;
}

export interface FinnyAtomicFetchClients {
  netsuite: FinnyNetSuiteClient;
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
    async executeOperation(input, _context, credentials) {
      const execute = createFinnyNetSuiteOperationExecutor({
        plan: input.plan,
        credential: netsuiteCredential(credentials.netsuite),
        client: clients.netsuite,
      });
      return { rows: await execute(input.execution) };
    },
  } satisfies AtomicFetchAdapter;
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

function invalidCredential(name: string): never {
  throw new Error(`${name} credential bundle is invalid`);
}
