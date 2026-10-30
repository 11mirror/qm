import type { ServiceCredentialReader } from "../credentials/keychain.ts";
import type { ScopeId } from "../types.ts";
import type {
  FinanceExecutionContext,
  FinanceOperationInput,
  FinanceOperationOutput,
  FinanceService,
} from "./finance.ts";
import { createFinnyPlanPreflight } from "./finance.ts";
import { FinanceFailure, financeFailureWithDiagnostic, type FinanceDiagnosticSink } from "./finance-failure.ts";

export interface FinnyCredentialSlugs {
  netsuite: string;
}

export interface AtomicFetchContext {
  runId: string;
  actorId: string;
  requestText?: string;
}

export interface AtomicFetchAdapter {
  executeOperation(
    input: FinanceOperationInput,
    context: AtomicFetchContext,
    credentials: { netsuite: string },
  ): Promise<FinanceOperationOutput>;
}

export interface BrokeredFinanceServiceOptions {
  delegate: FinanceService;
  credentialReader: ServiceCredentialReader;
  orgScopeId: ScopeId;
  credentialSlugs: FinnyCredentialSlugs;
  atomicFetch: AtomicFetchAdapter;
  diagnostics?: FinanceDiagnosticSink;
}

function safeContext(context: FinanceExecutionContext): AtomicFetchContext {
  return {
    runId: context.runId,
    actorId: context.actorId,
    ...(context.requestText ? { requestText: context.requestText } : {}),
  };
}

const sensitiveCredentialFields = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "consumerkey",
  "consumersecret",
  "password",
  "refreshtoken",
  "secret",
  "token",
  "tokenid",
  "tokensecret",
]);

function credentialFragments(secret: string): string[] {
  const fragments = new Set([secret]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return [...fragments];
  }
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "string" && sensitiveCredentialFields.has(key.toLowerCase())) {
        fragments.add(nested);
      } else {
        collect(nested);
      }
    }
  };
  collect(parsed);
  return [...fragments];
}

function outputContainsSecret(output: unknown, secrets: readonly string[]): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return true;
  }
  return secrets.flatMap(credentialFragments).some((fragment) => fragment.length > 0 && serialized.includes(fragment));
}

export function createBrokeredFinanceService(options: BrokeredFinanceServiceOptions): FinanceService {
  const credential = async (slug: string, context: FinanceExecutionContext): Promise<string> => {
    try {
      const stored = await options.credentialReader.getServiceCredentialSecret(options.orgScopeId, slug);
      if (stored?.enabled && stored.secret) return stored.secret;
    } catch (error) {
      throw financeFailureWithDiagnostic(error, {
        runId: context.runId,
        operation: `credential read ${slug}`,
        cause: "credential_missing",
        retryable: false,
        dependency: slug,
        message: `blocked_external: QM service credential ${slug} is unavailable`,
        diagnostics: options.diagnostics,
      });
    }
    throw new FinanceFailure("credential_missing", {
      retryable: false,
      dependency: slug,
      message: `blocked_external: QM service credential ${slug} is unavailable`,
    });
  };

  const run = async <Result>(
    operation: string,
    secrets: readonly (string | undefined)[],
    context: FinanceExecutionContext,
    invoke: () => Promise<Result>,
  ): Promise<Result> => {
    let result: Result;
    try {
      result = await invoke();
    } catch (error) {
      throw financeFailureWithDiagnostic(error, {
        runId: context.runId,
        operation,
        cause: "provider_unavailable",
        retryable: true,
        dependency: "finance-provider",
        message: `blocked_external: ${operation} failed`,
        diagnostics: options.diagnostics,
      });
    }
    if (
      outputContainsSecret(
        result,
        secrets.filter((secret): secret is string => secret !== undefined),
      )
    ) {
      throw financeFailureWithDiagnostic(new FinanceFailure("provider_unavailable"), {
        runId: context.runId,
        operation: "credential boundary",
        cause: "provider_unavailable",
        retryable: false,
        dependency: "credential-boundary",
        message: "blocked_external: credential boundary rejected adapter output",
        diagnostics: options.diagnostics,
      });
    }
    return result;
  };

  return {
    clarify: (input, context) => options.delegate.clarify(input, context),
    preflightPlan: async (input) => createFinnyPlanPreflight(input),
    executeOperation: async (input, context) => {
      const netsuite = await credential(options.credentialSlugs.netsuite, context);
      return run("operation execution", [netsuite], context, () =>
        options.atomicFetch.executeOperation(input, safeContext(context), { netsuite }),
      );
    },
    sourcePlan: async (input, context) => {
      return options.delegate.sourcePlan(input, context);
    },
    recoverSource: (input, context) => options.delegate.recoverSource(input, context),
    artifact: (input, context) => options.delegate.artifact(input, context),
    verify: (input, context) => options.delegate.verify(input, context),
  };
}
