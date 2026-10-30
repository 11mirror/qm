import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { artifactPath, fileArtifactId } from "../files/file-artifact-store.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { validateFinnyAccounting, type FinnyVerificationPolicy } from "./accounting-validator.ts";
import type {
  FinanceActionInputMap,
  FinanceActionOutputMap,
  FinanceExecutionContext,
  FinanceService,
} from "./finance.ts";
import { digestFinnyEvidence, type FinnyDigest } from "./golden-loop.ts";

interface EvidenceBackedFinanceServiceOptions {
  delegate: FinanceService;
  files: FileArtifactStore;
  evidenceBytes: DurableByteStore;
  artifactThresholdRows?: number;
}

interface SourceEnvelope {
  schema: "finny.source.v1";
  runId: string;
  planDigest: FinnyDigest;
  query: string;
  verificationPolicy: FinnyVerificationPolicy;
  records: readonly unknown[];
}

export function createEvidenceBackedFinanceService(options: EvidenceBackedFinanceServiceOptions): FinanceService {
  const threshold = options.artifactThresholdRows ?? 10;
  if (!Number.isInteger(threshold) || threshold < 0) throw new Error("Artifact row threshold is invalid");

  const preflight = async (
    input: FinanceActionInputMap["preflight"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["preflight"]> => {
    const query = input.query;
    const output = await options.delegate.preflight({ ...input, query }, context);
    const bytes = Buffer.from(`finny-query:v1:${query}`, "utf8");
    const queryDigest = digestFinnyEvidence(bytes);
    const stored = await options.evidenceBytes.put(bytes);
    if (stored.sha256 !== digestHex(queryDigest)) throw new Error("Durable finance query digest mismatch");
    return { ...output, queryDigest };
  };

  const source = async (
    input: FinanceActionInputMap["source"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["source"]> => {
    if (!context.approvedQueryDigest) throw new Error("Approved finance query custody is unavailable");
    const query = await loadApprovedQuery(options.evidenceBytes, context.approvedQueryDigest);
    const output = await options.delegate.source({ planDigest: input.planDigest, query }, context);
    const envelope: SourceEnvelope = {
      schema: "finny.source.v1",
      runId: context.runId,
      planDigest: input.planDigest,
      query,
      verificationPolicy: context.verificationPolicy ?? "repeatable_read",
      records: output.records,
    };
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    const sourceDigest = digestFinnyEvidence(bytes);
    const stored = await options.evidenceBytes.put(bytes);
    if (stored.sha256 !== digestHex(sourceDigest)) throw new Error("Durable finance source evidence digest mismatch");
    return { records: output.records, sourceDigest };
  };

  const artifact = async (
    input: FinanceActionInputMap["artifact"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["artifact"]> => {
    const evidence = await loadEvidence(options.evidenceBytes, context, input.sourceDigest);
    const requirement =
      input.requirement === "required" || evidence.records.length > threshold ? "required" : "optional";
    const policyDigest = digestFinnyEvidence(
      `finny-artifact-policy:v2:requested:${input.requirement ?? "optional"}:rows>${threshold}:${requirement}:${evidence.records.length}`,
    );
    if (requirement === "optional") return { requirement, policyDigest };
    const report = buildReport(evidence.records);
    const artifactDigest = digestFinnyEvidence(report.bytes);
    const id = reportArtifactId(context.runId, input.sourceDigest, artifactDigest);
    const name = `finny-report-${id.slice(0, 12)}.${report.extension}`;
    const published = await options.files.put({
      id,
      ownerScopeId: context.scopeId,
      createdBy: "system:finny",
      name,
      path: artifactPath(id, name),
      mimetype: report.mimetype,
      data: report.bytes,
      direction: "out",
      createdInScope: context.scopeId,
    });
    if (published.artifact.sha256 !== digestHex(artifactDigest))
      throw new Error("Finance report artifact digest mismatch");
    return {
      requirement,
      policyDigest,
      artifactDigest,
      reference: published.artifact.path,
    };
  };

  const verify = async (
    input: FinanceActionInputMap["verify"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["verify"]> => {
    const evidence = await loadEvidence(options.evidenceBytes, context, input.sourceDigest);
    const required = input.requirement === "required";
    const expectedArtifactDigest = required ? digestFinnyEvidence(buildReport(evidence.records).bytes) : undefined;
    const expectedArtifactId = expectedArtifactDigest
      ? reportArtifactId(context.runId, input.sourceDigest, expectedArtifactDigest)
      : undefined;
    const openedArtifact = expectedArtifactId ? await options.files.open(expectedArtifactId) : undefined;
    let openedArtifactDigest: FinnyDigest | undefined;
    if (openedArtifact) {
      const chunks: Buffer[] = [];
      for await (const chunk of openedArtifact.stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes);
      }
      openedArtifactDigest = digestFinnyEvidence(Buffer.concat(chunks));
    }
    const artifactMatches =
      !required ||
      (expectedArtifactDigest !== undefined &&
        input.artifactDigest === expectedArtifactDigest &&
        openedArtifact?.artifact.ownerScopeId === context.scopeId &&
        openedArtifact.artifact.sha256 === digestHex(expectedArtifactDigest) &&
        openedArtifactDigest === expectedArtifactDigest);
    const repeated = await options.delegate.source({ planDigest: evidence.planDigest, query: evidence.query }, context);
    const sourceMatches = canonicalJson(repeated.records) === canonicalJson(evidence.records);
    const accounting = validateFinnyAccounting(evidence.records, evidence.verificationPolicy);
    const passed = artifactMatches && sourceMatches && accounting.passed;
    return {
      passed,
      verificationDigest: digestFinnyEvidence(
        canonicalJson({
          schema: "finny.verification.v1",
          sourceDigest: input.sourceDigest,
          artifactDigest: input.artifactDigest ?? null,
          requirement: input.requirement ?? null,
          rowCount: evidence.records.length,
          artifactMatches,
          sourceMatches,
          accounting,
        }),
      ),
    };
  };

  const recoverSource = async (
    input: Pick<FinanceActionInputMap["artifact"], "sourceDigest">,
    context: FinanceExecutionContext,
  ): Promise<Pick<FinanceActionOutputMap["source"], "records">> => ({
    records: (await loadEvidence(options.evidenceBytes, context, input.sourceDigest)).records,
  });

  return {
    clarify: (input, context) => options.delegate.clarify(input, context),
    preflight,
    plan: (input, context) => options.delegate.plan(input, context),
    source,
    artifact,
    verify,
    recoverSource,
  };
}

async function loadEvidence(
  evidenceBytes: DurableByteStore,
  context: FinanceExecutionContext,
  sourceDigest: FinnyDigest,
): Promise<SourceEnvelope> {
  const blobKey = `files/${digestHex(sourceDigest)}`;
  const opened = await evidenceBytes.open(blobKey);
  if (!opened) throw new Error("Durable finance source evidence is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (digestFinnyEvidence(bytes) !== sourceDigest) throw new Error("Durable finance source evidence digest mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Durable finance source evidence is invalid");
  }
  if (!isSourceEnvelope(parsed, context.runId)) throw new Error("Durable finance source evidence is invalid");
  return parsed;
}

async function loadApprovedQuery(evidenceBytes: DurableByteStore, queryDigest: FinnyDigest): Promise<string> {
  const blobKey = `files/${digestHex(queryDigest)}`;
  const opened = await evidenceBytes.open(blobKey);
  if (!opened) throw new Error("Approved finance query custody is unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (digestFinnyEvidence(bytes) !== queryDigest) throw new Error("Durable finance query digest mismatch");
  const prefix = "finny-query:v1:";
  const value = bytes.toString("utf8");
  if (!value.startsWith(prefix) || value.length === prefix.length) throw new Error("Approved finance query is invalid");
  return value.slice(prefix.length);
}

function reportArtifactId(runId: string, sourceDigest: FinnyDigest, artifactDigest: FinnyDigest): string {
  return fileArtifactId(`finny-report:${runId}:${sourceDigest}:${artifactDigest}`, "out", 0);
}

function digestHex(digest: FinnyDigest): string {
  return digest.slice("sha256:".length);
}

function isSourceEnvelope(value: unknown, runId: string): value is SourceEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === "finny.source.v1" &&
    record.runId === runId &&
    typeof record.planDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(record.planDigest) &&
    typeof record.query === "string" &&
    record.query.length > 0 &&
    isVerificationPolicy(record.verificationPolicy) &&
    Array.isArray(record.records)
  );
}

function isVerificationPolicy(value: unknown): value is FinnyVerificationPolicy {
  return (
    value === "repeatable_read" ||
    value === "single_numeric_total" ||
    value === "balanced_debits_credits" ||
    value === "balance_sheet_equation"
  );
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("Finance evidence contains a non-finite number");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) throw new Error("Finance evidence contains a cycle");
      seen.add(candidate);
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort()) {
        const nested = (candidate as Record<string, unknown>)[key];
        if (nested === undefined) throw new Error("Finance evidence contains undefined data");
        normalized[key] = normalize(nested);
      }
      seen.delete(candidate);
      return normalized;
    }
    throw new Error("Finance evidence contains unsupported data");
  };
  return JSON.stringify(normalize(value));
}

function buildReport(records: readonly unknown[]): {
  bytes: Buffer;
  extension: "csv" | "json";
  mimetype: "text/csv" | "application/json";
} {
  if (records.every(isFlatRecord)) {
    const columns = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
    if (columns.length) {
      const lines = [
        columns.map(csvCell).join(","),
        ...records.map((record) => columns.map((column) => csvCell(record[column])).join(",")),
      ];
      return { bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"), extension: "csv", mimetype: "text/csv" };
    }
  }
  const body = canonicalJson({ schema: "finny.report.v1", records });
  return { bytes: Buffer.from(`${body}\n`, "utf8"), extension: "json", mimetype: "application/json" };
}

function isFlatRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (field) => field === null || ["string", "number", "boolean"].includes(typeof field),
  );
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const rendered = value == null ? "" : String(value);
  return /[",\r\n]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
}
