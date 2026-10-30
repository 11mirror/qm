import { randomUUID } from "node:crypto";

export const FINANCE_FAILURE_CAUSES = [
  "unsupported_template",
  "schema_mapping_required",
  "credential_missing",
  "invalid_config",
  "provider_auth",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "invalid_response",
  "verification_failed",
  "policy_block",
  "internal_error",
] as const;

export type FinanceFailureCause = (typeof FINANCE_FAILURE_CAUSES)[number];

export function isFinanceFailureCause(value: string): value is FinanceFailureCause {
  return FINANCE_FAILURE_CAUSES.some((cause) => cause === value);
}

export interface FinanceFailureMetadata {
  cause: FinanceFailureCause;
  retryable: boolean;
  dependency?: string;
  diagnosticId?: string;
  providerStatus?: number;
}

export interface FinanceDiagnosticEvent {
  runId: string;
  operation: string;
  failure: FinanceFailureMetadata;
}

export interface FinanceDiagnosticSink {
  record(event: FinanceDiagnosticEvent): void;
}

interface FinanceFailureOptions {
  retryable?: boolean;
  dependency?: string;
  diagnosticId?: string;
  providerStatus?: number;
  message?: string;
}

const EXTERNAL_CAUSES = new Set<FinanceFailureCause>([
  "credential_missing",
  "invalid_config",
  "provider_auth",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
]);

const DEFAULT_RETRYABLE = new Set<FinanceFailureCause>([
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
]);

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isSafeFinanceLabel(value: string): boolean {
  return SAFE_LABEL.test(value);
}

export function isSafeFinanceProviderStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function safeLabel(value: string | undefined): string | undefined {
  return value && isSafeFinanceLabel(value) ? value : undefined;
}

function safeProviderStatus(value: number | undefined): number | undefined {
  return value !== undefined && isSafeFinanceProviderStatus(value) ? value : undefined;
}

export class FinanceFailure extends Error {
  readonly causeCode: FinanceFailureCause;
  readonly retryable: boolean;
  readonly dependency?: string;
  readonly diagnosticId?: string;
  readonly providerStatus?: number;

  constructor(cause: FinanceFailureCause, options: FinanceFailureOptions = {}) {
    super(options.message ?? `Finance action failed: ${cause}`);
    this.name = "FinanceFailure";
    this.causeCode = cause;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(cause);
    this.dependency = safeLabel(options.dependency);
    this.diagnosticId = safeLabel(options.diagnosticId);
    this.providerStatus = safeProviderStatus(options.providerStatus);
  }

  toSafeMetadata(): FinanceFailureMetadata {
    return {
      cause: this.causeCode,
      retryable: this.retryable,
      ...(this.dependency ? { dependency: this.dependency } : {}),
      ...(this.diagnosticId ? { diagnosticId: this.diagnosticId } : {}),
      ...(this.providerStatus ? { providerStatus: this.providerStatus } : {}),
    };
  }
}

export function financeFailureFromUnknown(error: unknown): FinanceFailure {
  if (error instanceof FinanceFailure) return error;
  if (error instanceof Error && error.message.startsWith("blocked_external:")) {
    return new FinanceFailure("provider_unavailable", {
      retryable: true,
      dependency: "finance-provider",
    });
  }
  return new FinanceFailure("internal_error");
}

export function financeFailureWithDiagnostic(
  error: unknown,
  options: {
    runId: string;
    operation: string;
    cause: FinanceFailureCause;
    dependency?: string;
    retryable?: boolean;
    message?: string;
    diagnostics?: FinanceDiagnosticSink;
  },
): FinanceFailure {
  const original = error instanceof FinanceFailure ? error : undefined;
  const failure = new FinanceFailure(original?.causeCode ?? options.cause, {
    retryable: original?.retryable ?? options.retryable,
    dependency: original?.dependency ?? options.dependency,
    diagnosticId: original?.diagnosticId ?? `finny-${randomUUID()}`,
    providerStatus: original?.providerStatus,
    message: options.message,
  });
  options.diagnostics?.record({
    runId: options.runId,
    operation: options.operation,
    failure: failure.toSafeMetadata(),
  });
  return failure;
}

export function financeFailureBlockerCode(cause: FinanceFailureCause): "blocked_external" | "finance_error" {
  return EXTERNAL_CAUSES.has(cause) ? "blocked_external" : "finance_error";
}
