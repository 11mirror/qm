import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { artifactPath, fileArtifactId } from "../files/file-artifact-store.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { strictCanonicalJson as canonicalJson } from "../util/canonical-json.ts";
import type {
  FinanceActionInputMap,
  FinanceActionOutputMap,
  FinanceExecutionContext,
  FinanceService,
} from "./finance.ts";
import { digestFinnyEvidence, replayFinnyLedger, type FinnyDigest, type FinnyGoldenLoopState } from "./golden-loop.ts";
import { digestFinnyCompiledOperation, runFinnyDurableOperationPlan } from "./durable-operation-runner.ts";
import type { FinnyOperationPlan } from "./operation-compiler.ts";
import {
  loadFinnyOperationPlan,
  loadFinnyOperationResult,
  storeFinnyOperationPlan,
  type FinnyOperationResultEnvelope,
} from "./operation-custody.ts";
import { digestFinnyOperationRows } from "./operation-runner.ts";
import type { FinnyRunV2Checkpoint } from "./run-store.ts";

export interface EvidenceBackedRunStore {
  checkpoint(runId: string, metadata: FinnyGoldenLoopState["ledger"][number]): Promise<FinnyRunV2Checkpoint>;
  load(runId: string): Promise<FinnyRunV2Checkpoint | null>;
}

interface EvidenceBackedFinanceServiceOptions {
  delegate: FinanceService;
  files: FileArtifactStore;
  evidenceBytes: DurableByteStore;
  runStore?: EvidenceBackedRunStore;
}

interface PlanSourceEnvelope {
  schema: "finny.source.v2";
  runId: string;
  planDigest: FinnyDigest;
  resultOperationId: string;
  resultDigest: FinnyDigest;
  records: readonly unknown[];
}

type StoredSourceEnvelope = PlanSourceEnvelope;

export function createEvidenceBackedFinanceService(options: EvidenceBackedFinanceServiceOptions): FinanceService {
  const sourcePlan: FinanceService["sourcePlan"] = async (input, context) => {
    if (!options.runStore) throw new Error("Finny plan-native source requires a durable v2 run store");
    const reference = await storeFinnyOperationPlan(options.evidenceBytes, input.plan);
    const plan = await loadFinnyOperationPlan(options.evidenceBytes, reference);
    const targetOperationIds = [...new Set([plan.resultOperationId, ...plan.verificationPolicy.requiredOperationIds])];
    const runStore = options.runStore;
    const results = await runFinnyDurableOperationPlan({
      runId: context.runId,
      plan,
      targetOperationIds,
      runStore,
      resultBytes: options.evidenceBytes,
      executeExternal: async (execution) =>
        (await options.delegate.executeOperation({ plan, execution }, context)).rows,
    });
    const result = results[plan.resultOperationId];
    if (!result) throw new Error("Finny plan result operation is unavailable");
    const checkpoint = await runStore.load(context.runId);
    if (!checkpoint) throw new Error("Finny plan checkpoint is unavailable");
    const state = replayFinnyLedger(context.runId, checkpoint.ledger);
    const resultDigest = state.completedOperations[plan.resultOperationId]?.resultDigest;
    if (!resultDigest) throw new Error("Finny plan result custody is unavailable");
    const envelope: PlanSourceEnvelope = {
      schema: "finny.source.v2",
      runId: context.runId,
      planDigest: plan.planDigest,
      resultOperationId: plan.resultOperationId,
      resultDigest,
      records: result.rows,
    };
    const bytes = Buffer.from(canonicalJson(envelope), "utf8");
    const sourceDigest = digestFinnyEvidence(bytes);
    const stored = await options.evidenceBytes.put(bytes);
    if (stored.sha256 !== digestHex(sourceDigest)) throw new Error("Durable finance source evidence digest mismatch");
    return { records: result.rows, sourceDigest };
  };

  const artifact = async (
    input: FinanceActionInputMap["artifact"],
    context: FinanceExecutionContext,
  ): Promise<FinanceActionOutputMap["artifact"]> => {
    const evidence = await loadEvidence(options.evidenceBytes, context, input.sourceDigest);
    const decision = await artifactDecision(options.evidenceBytes, evidence, input.requirement);
    const { requirement, policyDigest } = decision;
    if (requirement === "optional") return { requirement, policyDigest };
    const report = buildReport(evidence.records, decision.format);
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
    const decision = await artifactDecision(options.evidenceBytes, evidence, input.requirement);
    const artifactPolicyMatches = input.requirement === decision.requirement;
    const expectedArtifactDigest = required
      ? digestFinnyEvidence(buildReport(evidence.records, decision.format).bytes)
      : undefined;
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
      artifactPolicyMatches &&
      (!required ||
        (expectedArtifactDigest !== undefined &&
          input.artifactDigest === expectedArtifactDigest &&
          openedArtifact?.artifact.ownerScopeId === context.scopeId &&
          openedArtifact.artifact.sha256 === digestHex(expectedArtifactDigest) &&
          openedArtifactDigest === expectedArtifactDigest));
    const verified = await verifyPlanEvidence(options, context, evidence);
    return {
      passed: artifactMatches && verified.reconciled,
      verificationDigest: digestFinnyEvidence(
        canonicalJson({
          schema: "finny.verification.v2",
          sourceDigest: input.sourceDigest,
          artifactDigest: input.artifactDigest ?? null,
          requirement: input.requirement ?? null,
          rowCount: evidence.records.length,
          artifactMatches,
          artifactPolicyDigest: decision.policyDigest,
          authority: verified.authority,
          results: verified.results,
          reconciled: verified.reconciled,
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
    sourcePlan,
    executeOperation: (input, context) => options.delegate.executeOperation(input, context),
    artifact,
    verify,
    recoverSource,
  };
}

async function loadEvidence(
  evidenceBytes: DurableByteStore,
  context: FinanceExecutionContext,
  sourceDigest: FinnyDigest,
): Promise<StoredSourceEnvelope> {
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
  if (!isPlanSourceEnvelope(parsed, context.runId)) throw new Error("Durable finance source evidence is invalid");
  return parsed;
}

function reportArtifactId(runId: string, sourceDigest: FinnyDigest, artifactDigest: FinnyDigest): string {
  return fileArtifactId(`finny-report:${runId}:${sourceDigest}:${artifactDigest}`, "out", 0);
}

function digestHex(digest: FinnyDigest): string {
  return digest.slice("sha256:".length);
}

function isPlanSourceEnvelope(value: unknown, runId: string): value is PlanSourceEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === "finny.source.v2" &&
    record.runId === runId &&
    typeof record.planDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(record.planDigest) &&
    typeof record.resultOperationId === "string" &&
    /^[a-z][a-z0-9_]*$/.test(record.resultOperationId) &&
    typeof record.resultDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(record.resultDigest) &&
    Array.isArray(record.records)
  );
}

function operationClosure(plan: FinnyOperationPlan, targetOperationIds: readonly string[]): Set<string> {
  const operations = new Map(plan.operations.map((operation) => [operation.id, operation]));
  const closure = new Set<string>();
  const visit = (operationId: string): void => {
    if (closure.has(operationId)) return;
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Finny verification operation ${operationId} is unavailable`);
    closure.add(operationId);
    for (const dependency of operation.dependsOn) visit(dependency);
  };
  for (const operationId of targetOperationIds) visit(operationId);
  return closure;
}

function assertCheckpointPlan(
  checkpoint: FinnyRunV2Checkpoint,
  state: FinnyGoldenLoopState,
  plan: FinnyOperationPlan,
  context: FinanceExecutionContext,
): void {
  if (
    checkpoint.schema !== "finny.run.v2" ||
    checkpoint.runId !== context.runId ||
    checkpoint.scopeId !== context.scopeId ||
    checkpoint.plan.planDigest !== plan.planDigest ||
    checkpoint.plan.catalogDigest !== plan.catalogDigest ||
    checkpoint.plan.capabilityId !== plan.capabilityId ||
    checkpoint.plan.revisionId !== plan.revisionId ||
    checkpoint.plan.operationGraphDigest !== plan.operationGraphDigest ||
    state.planDigest !== plan.planDigest ||
    state.catalogDigest !== plan.catalogDigest ||
    state.manifestDigest !== plan.manifestDigest ||
    state.capabilityId !== plan.capabilityId ||
    state.revisionId !== plan.revisionId ||
    state.operationGraphDigest !== plan.operationGraphDigest
  )
    throw new Error("Finny plan verification authority does not match the durable checkpoint");
}

async function verifyPlanEvidence(
  options: EvidenceBackedFinanceServiceOptions,
  context: FinanceExecutionContext,
  evidence: PlanSourceEnvelope,
): Promise<{
  authority: Record<string, unknown>;
  results: readonly Record<string, unknown>[];
  reconciled: boolean;
}> {
  if (!options.runStore) throw new Error("Finny plan-native verification requires a durable v2 run store");
  const plan = await loadFinnyOperationPlan(options.evidenceBytes, {
    blobKey: `files/${digestHex(evidence.planDigest)}`,
    planDigest: evidence.planDigest,
  });
  if (plan.resultOperationId !== evidence.resultOperationId)
    throw new Error("Finny source result operation does not match the custodied plan");
  const checkpoint = await options.runStore.load(context.runId);
  if (!checkpoint) throw new Error("Finny plan checkpoint is unavailable");
  const state = replayFinnyLedger(context.runId, checkpoint.ledger);
  assertCheckpointPlan(checkpoint, state, plan, context);
  const targets = [...new Set([plan.resultOperationId, ...plan.verificationPolicy.requiredOperationIds])];
  const closure = operationClosure(plan, targets);
  const custodyDigests: Record<string, FinnyDigest> = {};
  const envelopes = new Map<string, FinnyOperationResultEnvelope>();
  const results: Record<string, unknown>[] = [];
  for (const [ordinal, operation] of plan.operations.entries()) {
    if (!closure.has(operation.id)) continue;
    const completed = state.completedOperations[operation.id];
    if (!completed) throw new Error(`Finny required operation result ${operation.id} is unavailable`);
    const operationDigest = digestFinnyCompiledOperation(plan.planDigest, ordinal, operation);
    if (completed.primitive !== operation.primitive || completed.operationDigest !== operationDigest)
      throw new Error(`Finny required operation result ${operation.id} does not match the custodied plan`);
    const dependencyResults = operation.dependsOn.map((operationId) => {
      const resultDigest = custodyDigests[operationId];
      if (!resultDigest) throw new Error(`Finny operation result dependency ${operationId} is unavailable`);
      return { operationId, resultDigest };
    });
    const envelope = await loadFinnyOperationResult(options.evidenceBytes, {
      runId: context.runId,
      planDigest: plan.planDigest,
      operationId: operation.id,
      operationDigest,
      dependencyResults,
      resultDigest: completed.resultDigest,
    });
    custodyDigests[operation.id] = completed.resultDigest;
    envelopes.set(operation.id, envelope);
    results.push({
      operationId: operation.id,
      primitive: operation.primitive,
      operationDigest,
      resultDigest: completed.resultDigest,
      dependencyResults,
      outputDigest: digestFinnyOperationRows(envelope.output),
    });
  }
  const delivered = envelopes.get(plan.resultOperationId);
  if (
    !delivered ||
    custodyDigests[plan.resultOperationId] !== evidence.resultDigest ||
    canonicalJson(delivered.output) !== canonicalJson(evidence.records)
  )
    throw new Error("Finny delivered result does not match its durable custody");
  const requiredOperationIds = new Set(plan.verificationPolicy.requiredOperationIds);
  const reconcileOperations = plan.operations.filter(
    (operation) =>
      requiredOperationIds.has(operation.id) && closure.has(operation.id) && operation.primitive === "reconcile",
  );
  const reconciled =
    reconcileOperations.length > 0 &&
    reconcileOperations.every((operation) => {
      const rows = envelopes.get(operation.id)?.output;
      return Boolean(rows?.length) && rows!.every((row) => row.reconciled === true);
    });
  return {
    authority: {
      planDigest: plan.planDigest,
      manifestDigest: plan.manifestDigest,
      catalogDigest: plan.catalogDigest,
      capabilityId: plan.capabilityId,
      revisionId: plan.revisionId,
      operationGraphDigest: plan.operationGraphDigest,
      resultOperationId: plan.resultOperationId,
      requiredOperationIds: plan.verificationPolicy.requiredOperationIds,
      artifactPolicyDigest: plan.artifactPolicyDigest,
      approvalPolicyDigest: plan.approvalPolicyDigest,
      verificationPolicyDigest: plan.verificationPolicyDigest,
    },
    results,
    reconciled,
  };
}

async function artifactDecision(
  evidenceBytes: DurableByteStore,
  evidence: StoredSourceEnvelope,
  requested: "required" | "optional" | undefined,
): Promise<{
  requirement: "required" | "optional";
  policyDigest: FinnyDigest;
  format?: "json" | "csv";
}> {
  const plan = await loadFinnyOperationPlan(evidenceBytes, {
    blobKey: `files/${digestHex(evidence.planDigest)}`,
    planDigest: evidence.planDigest,
  });
  if (plan.resultOperationId !== evidence.resultOperationId)
    throw new Error("Finny source result operation does not match the custodied plan");
  if (
    !Array.isArray(plan.artifactPolicy.allowedFormats) ||
    !plan.artifactPolicy.allowedFormats.includes(plan.artifactPolicy.defaultFormat) ||
    !["json", "csv"].includes(plan.artifactPolicy.defaultFormat) ||
    !["never", "when_requested", "always"].includes(plan.artifactPolicy.attachment)
  )
    throw new Error("Finny custodied artifact policy is invalid");
  const attachment = plan.artifactPolicy.attachment;
  const requirement =
    attachment === "always" || (attachment === "when_requested" && requested === "required") ? "required" : "optional";
  const format = plan.artifactPolicy.defaultFormat;
  return {
    requirement,
    format,
    policyDigest: digestFinnyEvidence(
      canonicalJson({
        schema: "finny.artifact_policy.v3",
        planDigest: plan.planDigest,
        artifactPolicyDigest: plan.artifactPolicyDigest,
        requested: requested ?? "optional",
        requirement,
        format,
      }),
    ),
  };
}

function buildReport(
  records: readonly unknown[],
  format?: "json" | "csv",
): {
  bytes: Buffer;
  extension: "csv" | "json";
  mimetype: "text/csv" | "application/json";
} {
  if (format !== "json" && records.every(isFlatRecord)) {
    const columns = [...new Set(records.flatMap((record) => Object.keys(record)))].sort();
    if (columns.length) {
      const lines = [
        columns.map(csvCell).join(","),
        ...records.map((record) => columns.map((column) => csvCell(record[column])).join(",")),
      ];
      return { bytes: Buffer.from(`${lines.join("\n")}\n`, "utf8"), extension: "csv", mimetype: "text/csv" };
    }
  }
  if (format === "csv") throw new Error("Finance report rows are incompatible with the reviewed CSV format");
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
  const rendered = neutralizeSpreadsheetFormula(value == null ? "" : String(value));
  return /[",\r\n]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
}

function neutralizeSpreadsheetFormula(value: string): string {
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset)!;
    const character = String.fromCodePoint(codePoint);
    if (codePoint > 32 && (codePoint < 127 || codePoint > 159) && character.trim().length) break;
    offset += character.length;
  }
  return ["=", "+", "-", "@"].includes(value[offset] ?? "") ? `'${value}` : value;
}
