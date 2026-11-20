import { createHash } from "node:crypto";
import { Errors } from "typebox/value";
import { canonicalJson } from "../../cli/src/canonical-json.ts";
import type {
  FinnyAuditEnvelope,
  FinnyJob,
  FinnyMaterialClarification,
  FinnyPlanPresentation,
  FinnyProducerTask,
  FinnySopVersion,
  FinnyWorkerRole,
} from "./types.ts";
import { FINNY_SOP_SCHEMA } from "./sop-schema.ts";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny plan ${label} is invalid`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Finny plan ${label} is invalid`);
  return value.map((item) => text(item, label));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Finny SOP ${label} is invalid`);
  return value as Record<string, unknown>;
}

function uniqueIds(items: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Finny SOP ${label} IDs must be unique`);
    ids.add(item.id);
  }
}

function jsonValue(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => jsonValue(item, label)));
  const input = record(value, label);
  const output = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, jsonValue(item, label)]));
  return Object.freeze(output);
}

function frozenArray<T>(items: T[]): T[] {
  return Object.freeze(items) as T[];
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

export function validateFinnySopVersion(value: unknown): FinnySopVersion {
  const [error] = Errors(FINNY_SOP_SCHEMA, value);
  if (error) {
    const path = error.instancePath || "/";
    const evidence =
      error.keyword === "additionalProperties"
        ? `${error.message}: ${error.params.additionalProperties.join(", ")}`
        : error.message;
    throw new Error(`Finny SOP shape is invalid at ${path}: ${evidence}`);
  }
  const root = value as FinnySopVersion;
  const inputs = root.inputs.map((input) => Object.freeze({ ...input }));
  uniqueIds(inputs, "input");
  const inputIds = new Set(inputs.map((input) => input.id));
  const sources = root.sources.map((source) => {
    if (source.asOfInput && !inputIds.has(source.asOfInput))
      throw new Error(`Finny SOP source as-of input ${source.asOfInput} is unknown`);
    return Object.freeze({
      ...source,
      fields: frozenArray([...source.fields]),
    });
  });
  uniqueIds(sources, "source");
  const readable = new Set([...inputIds, ...sources.map((source) => source.id)]);
  const steps = root.steps.map((step) => {
    const unknown = step.reads.find((read) => !readable.has(read));
    if (unknown) throw new Error(`Finny SOP step read ${unknown} is unknown or out of order`);
    if (readable.has(step.writes)) throw new Error(`Finny SOP step write ${step.writes} is ambiguous`);
    readable.add(step.writes);
    return Object.freeze({
      ...step,
      reads: frozenArray([...step.reads]),
    });
  });
  uniqueIds(steps, "step");
  const outputs = root.outputs.map((output) => {
    const rerun =
      output.rerun === undefined
        ? undefined
        : (() => {
            const unknown = output.rerun.inputIds.find((id) => !inputIds.has(id));
            if (unknown) throw new Error(`Finny SOP output rerun input ${unknown} is unknown`);
            return Object.freeze({ inputIds: frozenArray([...output.rerun.inputIds]) });
          })();
    return Object.freeze({
      id: output.id,
      kind: output.kind,
      contract: jsonValue(output.contract, "output contract") as Record<string, unknown>,
      ...(rerun ? { rerun } : {}),
    });
  });
  if (!outputs.some((output) => output.kind === "xlsx")) throw new Error("Finny SOP must declare an XLSX workbook");
  if (!outputs.some((output) => output.kind === "summary"))
    throw new Error("Finny SOP must declare a certified summary");
  uniqueIds(outputs, "output");
  const evidence = new Set([...readable, ...outputs.map((output) => output.id)]);
  const controls = root.controls.map((control) => {
    const unknown = control.evidenceRefs.find((reference) => !evidence.has(reference));
    if (unknown) throw new Error(`Finny SOP control evidence reference ${unknown} is unknown`);
    return Object.freeze({
      ...control,
      evidenceRefs: frozenArray([...control.evidenceRefs]),
      ...(control.judgment ? { judgment: Object.freeze({ ...control.judgment }) } : {}),
    });
  });
  uniqueIds(controls, "control");
  return Object.freeze({
    schema: "finny.sop.v1",
    id: root.id,
    version: root.version,
    scopeId: root.scopeId,
    title: root.title,
    intent: Object.freeze({
      ...root.intent,
      searchTerms: frozenArray([...root.intent.searchTerms]),
    }),
    objective: root.objective,
    inputs: frozenArray(inputs),
    sources: frozenArray(sources),
    steps: frozenArray(steps),
    controls: frozenArray(controls),
    outputs: frozenArray(outputs),
    approval: Object.freeze({ ...root.approval }),
  });
}

export function assertFinnyCoreAuditableSop(value: unknown): asserts value is FinnySopVersion {
  const sop = validateFinnySopVersion(value);
  for (const control of sop.controls) {
    if (!control.deterministicCheckId) {
      throw new Error(`Finny SOP control ${control.id} has no deterministic check binding`);
    }
    if (control.judgment && control.judgment.triggerVerdict !== "block") {
      throw new Error(`Finny SOP judgment control ${control.id} has no deterministic trigger verdict`);
    }
  }
}

export function validateFinnySopValues(sopValue: unknown, value: unknown): Record<string, string | boolean> {
  const sop = validateFinnySopVersion(sopValue);
  const values = record(value, "bound input values");
  const inputs = new Map(sop.inputs.map((input) => [input.id, input]));
  const unknown = Object.keys(values).find((key) => !inputs.has(key));
  if (unknown) throw new Error(`Finny SOP bound input ${unknown} is undeclared`);
  const validated = Object.create(null) as Record<string, string | boolean>;
  for (const input of sop.inputs) {
    if (!Object.hasOwn(values, input.id)) {
      if (input.required) throw new Error(`Finny SOP required input ${input.id} is missing`);
      continue;
    }
    const bound = values[input.id];
    if (input.type === "boolean") {
      if (typeof bound !== "boolean") throw new Error(`Finny SOP input ${input.id} must be boolean`);
    } else if (typeof bound !== "string" || !bound.trim()) {
      throw new Error(`Finny SOP input ${input.id} must be text`);
    }
    validated[input.id] = bound as string | boolean;
  }
  return Object.freeze(validated);
}

export function canonicalFinnySopDefinitionDigest(value: unknown): string {
  return canonicalDigest(validateFinnySopVersion(value));
}

export function finnySopVersionId(value: unknown): string {
  const sop = validateFinnySopVersion(value);
  return `${encodeURIComponent(sop.scopeId)}/${encodeURIComponent(sop.id)}@${sop.version}`;
}

export function finnySopSearchText(value: unknown): string {
  const sop = validateFinnySopVersion(value);
  return [
    sop.title,
    sop.intent.description,
    ...sop.intent.searchTerms,
    sop.objective,
    ...sop.sources.flatMap((source) => [source.system, source.object]),
  ].join(" ");
}

export function canonicalFinnyExecutionDigest(sopValue: unknown, inputValues: unknown): string {
  const sop = validateFinnySopVersion(sopValue);
  const values = validateFinnySopValues(sop, inputValues);
  return canonicalDigest({
    schema: sop.schema,
    id: sop.id,
    version: sop.version,
    scopeId: sop.scopeId,
    objective: sop.objective,
    inputs: sop.inputs.map(({ id, from, type, required, material }) => ({
      id,
      from,
      type,
      required,
      material,
      ...(material && values[id] !== undefined ? { value: values[id] } : {}),
    })),
    sources: sop.sources,
    steps: sop.steps,
    controls: sop.controls,
    outputs: sop.outputs,
    approval: sop.approval,
  });
}

function compiledSop(sopValue: unknown, inputValues: unknown) {
  const sop = validateFinnySopVersion(sopValue);
  const boundInputs = validateFinnySopValues(sop, inputValues);
  return {
    sop,
    boundInputs,
    sopVersion: Object.freeze({ id: sop.id, version: sop.version, scopeId: sop.scopeId }),
    executionDigest: canonicalFinnyExecutionDigest(sop, boundInputs),
  };
}

export function compileFinnyProducerTask(sopValue: unknown, inputValues: unknown): FinnyProducerTask {
  const { sop, boundInputs, sopVersion, executionDigest } = compiledSop(sopValue, inputValues);
  return Object.freeze({
    schema: "finny.producer-task.v1",
    sopVersion,
    executionDigest,
    objective: sop.objective,
    boundInputs,
    sources: sop.sources,
    steps: sop.steps,
    controls: sop.controls,
    outputs: sop.outputs,
  });
}

export function compileFinnyAuditEnvelope(sopValue: unknown, inputValues: unknown): FinnyAuditEnvelope {
  const { sop, boundInputs, sopVersion, executionDigest } = compiledSop(sopValue, inputValues);
  return Object.freeze({
    schema: "finny.audit-envelope.v1",
    sopVersion,
    executionDigest,
    boundInputs,
    sources: sop.sources,
    controls: sop.controls,
    outputs: sop.outputs,
  });
}

export function compileFinnyWorkerTask(job: FinnyJob, role: FinnyWorkerRole): Record<string, unknown> {
  if (!job.sop || !job.sopBinding) throw new Error("Finny job has no SOP binding");
  const digest = canonicalFinnyExecutionDigest(job.sop, job.sopBinding.values);
  if (digest !== job.sopBinding.executionDigest) throw new Error("Finny job SOP execution digest does not match");
  const authority = {
    jobId: job.id,
    policy: job.policy,
    ...(job.findingPolicy ? { findingPolicy: job.findingPolicy } : {}),
  };
  if (role === "producer")
    return Object.freeze({
      ...compileFinnyProducerTask(job.sop, job.sopBinding.values),
      ...authority,
    });
  if (!job.artifactDigest) throw new Error("Finny audit task requires a bound artifact");
  return Object.freeze({
    ...compileFinnyAuditEnvelope(job.sop, job.sopBinding.values),
    ...authority,
    artifactDigest: job.artifactDigest,
  });
}

export function finnySopPlanPresentation(sopValue: unknown, inputValues: unknown): FinnyPlanPresentation {
  const sop = validateFinnySopVersion(sopValue);
  const values = validateFinnySopValues(sop, inputValues);
  const phases = sop.steps.map((step, index) => ({
    name: step.action,
    owner: "Producer",
    dependencies: index === 0 ? [] : [sop.steps[index - 1]!.action],
  }));
  const outputNames = sop.outputs.map((output) => {
    if (output.kind === "xlsx") return "XLSX workbook";
    if (output.kind === "summary") return "certified summary";
    return "app";
  });
  return validateFinnyPlanPresentation({
    title: sop.title,
    summary: sop.intent.description,
    phases,
    certification: sop.controls.map((control) => control.assertion).join("\n"),
    deliverable: outputNames.join(", "),
    destination: sop.approval.destination,
    clarifications: sop.inputs.flatMap((input) =>
      input.from === "human" && values[input.id] !== undefined
        ? [{ question: input.label, answer: String(values[input.id]) }]
        : [],
    ),
  });
}

export function validateFinnyPlanPresentation(value: FinnyPlanPresentation): FinnyPlanPresentation {
  if (!value || typeof value !== "object") throw new Error("Finny plan presentation is invalid");
  if (!Array.isArray(value.phases) || !value.phases.length) throw new Error("Finny plan phases are invalid");
  if (!Array.isArray(value.clarifications)) throw new Error("Finny plan clarifications are invalid");
  const validated: FinnyPlanPresentation = {
    title: text(value.title, "title"),
    ...(value.summary === undefined ? {} : { summary: text(value.summary, "summary") }),
    phases: value.phases.map((phase) =>
      Object.freeze({
        name: text(phase?.name, "phase name"),
        owner: text(phase?.owner, "phase owner"),
        dependencies: Object.freeze(stringArray(phase?.dependencies, "phase dependencies")) as string[],
      }),
    ),
    certification: text(value.certification, "certification"),
    deliverable: text(value.deliverable, "deliverable"),
    destination: text(value.destination, "destination"),
    clarifications: value.clarifications.map((clarification) =>
      Object.freeze({
        question: text(clarification?.question, "clarification question"),
        answer: text(clarification?.answer, "clarification answer"),
      }),
    ),
  };
  Object.freeze(validated.phases);
  Object.freeze(validated.clarifications);
  return Object.freeze(validated);
}

export function validateFinnyMaterialClarification(value: FinnyMaterialClarification): FinnyMaterialClarification {
  const question = text(value?.question, "material clarification question");
  if (!Array.isArray(value?.options) || value.options.length < 2 || value.options.length > 5)
    throw new Error("Finny material clarification must have 2 to 5 options");
  const optionIds = new Set<string>();
  const options = value.options.map((option) => {
    const id = text(option?.id, "material clarification option ID");
    if (id.length > 228) throw new Error("Finny material clarification option ID exceeds Slack limits");
    if (optionIds.has(id)) throw new Error("Finny material clarification option IDs must be unique");
    optionIds.add(id);
    return Object.freeze({
      id,
      label: text(option?.label, "material clarification option label"),
      ...(option.description === undefined
        ? {}
        : { description: text(option.description, "material clarification option description") }),
    });
  });
  const recommendedOptionId = text(value.recommendedOptionId, "material clarification recommendation");
  if (!optionIds.has(recommendedOptionId)) throw new Error("Finny material clarification recommendation is invalid");
  return Object.freeze({ question, options: Object.freeze(options) as typeof options, recommendedOptionId });
}

export function assertFinnyMaterialClarificationMatchesSop(
  sopValue: unknown,
  inputValues: unknown,
  clarification: FinnyMaterialClarification,
): void {
  const sop = validateFinnySopVersion(sopValue);
  const values = validateFinnySopValues(sop, inputValues);
  const validated = validateFinnyMaterialClarification(clarification);
  const recommended = validated.options.find((option) => option.id === validated.recommendedOptionId);
  const matches = sop.inputs.filter((input) => {
    const bound = values[input.id];
    return (
      input.material &&
      input.from === "human" &&
      bound !== undefined &&
      (String(bound) === recommended?.id || bound === recommended?.label)
    );
  });
  if (matches.length !== 1)
    throw new Error("Finny clarification does not unambiguously match one material SOP input value");
}
