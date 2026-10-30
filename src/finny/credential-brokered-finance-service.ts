import type { ServiceCredentialReader } from "../credentials/keychain.ts";
import type { ScopeId } from "../types.ts";
import type {
  FinanceActionInputMap,
  FinanceActionOutputMap,
  FinanceExecutionContext,
  FinanceOperationInput,
  FinanceOperationOutput,
  FinancePlanPreflightInput,
  FinancePlanPreflightOutput,
  FinanceService,
} from "./finance.ts";
import {
  FinanceFailure,
  financeFailureWithDiagnostic,
  type FinanceDiagnosticSink,
  type FinanceFailureMetadata,
} from "./finance-failure.ts";

export interface FinnyCredentialSlugs {
  hindsight: string;
  netsuite: string;
}

export interface AtomicFetchContext {
  runId: string;
  actorId: string;
  requestText?: string;
}

export type FinnyAdvisoryEnrichment =
  | {
      provider: "hindsight";
      state: "available";
      evidenceDigest: FinanceActionOutputMap["preflight"]["preflightDigest"];
    }
  | {
      provider: "hindsight";
      state: "omitted";
      reason: "credential_unavailable" | "provider_unavailable";
      failure?: FinanceFailureMetadata;
    };

export interface AtomicFetchAdapter {
  preflight(
    input: FinanceActionInputMap["preflight"],
    context: AtomicFetchContext,
    credentials: { hindsight?: string; hindsightFailure?: FinanceFailureMetadata },
  ): Promise<FinanceActionOutputMap["preflight"] & { enrichment?: FinnyAdvisoryEnrichment }>;
  source(
    input: FinanceActionInputMap["source"],
    context: AtomicFetchContext,
    credentials: { hindsight?: string; hindsightFailure?: FinanceFailureMetadata; netsuite: string },
  ): Promise<FinanceActionOutputMap["source"] & { enrichment?: FinnyAdvisoryEnrichment }>;
  preflightPlan?(
    input: FinancePlanPreflightInput,
    context: AtomicFetchContext,
    credentials: { hindsight?: string; hindsightFailure?: FinanceFailureMetadata },
  ): Promise<FinancePlanPreflightOutput & { enrichment?: FinnyAdvisoryEnrichment }>;
  executeOperation?(
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
  const credential = async (
    slug: string,
    required: boolean,
    context: FinanceExecutionContext,
  ): Promise<{ secret?: string; failure?: FinanceFailureMetadata }> => {
    try {
      const stored = await options.credentialReader.getServiceCredentialSecret(options.orgScopeId, slug);
      if (stored?.enabled && stored.secret) return { secret: stored.secret };
    } catch (error) {
      const failure = financeFailureWithDiagnostic(error, {
        runId: context.runId,
        operation: `credential read ${slug}`,
        cause: "credential_missing",
        retryable: false,
        dependency: slug,
        message: `blocked_external: QM service credential ${slug} is unavailable`,
        diagnostics: options.diagnostics,
      });
      if (required) throw failure;
      return { failure: failure.toSafeMetadata() };
    }
    if (!required) return {};
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
    preflightPlan: async (input, context) => {
      if (!options.atomicFetch.preflightPlan)
        throw new FinanceFailure("provider_unavailable", {
          retryable: false,
          dependency: "finance-provider",
          message: "blocked_external: operation plan preflight is unavailable",
        });
      const hindsight = await credential(options.credentialSlugs.hindsight, false, context);
      return run("operation plan preflight", [hindsight.secret], context, () =>
        options.atomicFetch.preflightPlan!(input, safeContext(context), {
          hindsight: hindsight.secret,
          hindsightFailure: hindsight.failure,
        }),
      );
    },
    executeOperation: async (input, context) => {
      if (!options.atomicFetch.executeOperation)
        throw new FinanceFailure("provider_unavailable", {
          retryable: false,
          dependency: "finance-provider",
          message: "blocked_external: operation execution is unavailable",
        });
      const netsuite = await credential(options.credentialSlugs.netsuite, true, context);
      return run("operation execution", [netsuite.secret], context, () =>
        options.atomicFetch.executeOperation!(input, safeContext(context), { netsuite: netsuite.secret! }),
      );
    },
    sourcePlan: async (input, context) => {
      if (!options.delegate.sourcePlan)
        throw new FinanceFailure("provider_unavailable", {
          retryable: false,
          dependency: "finance-provider",
          message: "blocked_external: operation plan source custody is unavailable",
        });
      return options.delegate.sourcePlan(input, context);
    },
    preflight: async (input, context) => {
      const hindsight = await credential(options.credentialSlugs.hindsight, false, context);
      return run("atomic preflight", [hindsight.secret], context, () =>
        options.atomicFetch.preflight(input, safeContext(context), {
          hindsight: hindsight.secret,
          hindsightFailure: hindsight.failure,
        }),
      );
    },
    plan: (input, context) => options.delegate.plan(input, context),
    source: async (input, context) => {
      const [hindsight, netsuite] = await Promise.all([
        credential(options.credentialSlugs.hindsight, false, context),
        credential(options.credentialSlugs.netsuite, true, context),
      ]);
      return run("atomic source fetch", [hindsight.secret, netsuite.secret], context, () =>
        options.atomicFetch.source(input, safeContext(context), {
          hindsight: hindsight.secret,
          hindsightFailure: hindsight.failure,
          netsuite: netsuite.secret!,
        }),
      );
    },
    artifact: (input, context) => options.delegate.artifact(input, context),
    verify: (input, context) => options.delegate.verify(input, context),
  };
}
