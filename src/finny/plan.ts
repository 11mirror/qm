import { createHash } from "node:crypto";
import type {
  FinnyAuditEnvelope,
  FinnyJob,
  FinnyMaterialClarification,
  FinnyPlanPresentation,
  FinnyProducerTask,
  FinnySopVersion,
  FinnyWorkerRole,
} from "./types.ts";

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

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const validated = record(value, label);
  const unknown = Object.keys(validated).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`Finny SOP ${label} has unknown field ${unknown}`);
  return validated;
}

function sopText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Finny SOP ${label} is invalid`);
  return value;
}

function sopBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Finny SOP ${label} is invalid`);
  return value;
}

function sopArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Finny SOP ${label} is invalid`);
  return value;
}

function sopStringArray(value: unknown, label: string): string[] {
  return sopArray(value, label).map((item) => sopText(item, label));
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Finny SOP ${label} is invalid`);
  return value as T;
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("base64url");
}

export function validateFinnySopVersion(value: unknown): FinnySopVersion {
  const root = exact(
    value,
    ["schema", "id", "version", "scopeId", "title", "intent", "objective", "inputs", "sources", "steps", "controls", "outputs", "approval"],
    "version",
  );
  if (root.schema !== "finny.sop.v1") throw new Error("Finny SOP schema is invalid");
  if (!Number.isSafeInteger(root.version) || (root.version as number) < 1)
    throw new Error("Finny SOP version is invalid");
  const intent = exact(root.intent, ["domain", "description", "searchTerms"], "intent");
  const inputs = sopArray(root.inputs, "inputs").map((item) => {
    const input = exact(item, ["id", "label", "from", "type", "required", "material"], "input");
    return Object.freeze({
      id: sopText(input.id, "input ID"),
      label: sopText(input.label, "input label"),
      from: enumValue(input.from, ["human", "system"] as const, "input origin"),
      type: enumValue(input.type, ["date", "text", "currency", "entity", "boolean"] as const, "input type"),
      required: sopBoolean(input.required, "input required flag"),
      material: sopBoolean(input.material, "input material flag"),
    });
  });
  uniqueIds(inputs, "input");
  const inputIds = new Set(inputs.map((input) => input.id));
  const sources = sopArray(root.sources, "sources").map((item) => {
    const source = exact(item, ["id", "system", "object", "fields", "filter", "asOfInput"], "source");
    const asOfInput = source.asOfInput === undefined ? undefined : sopText(source.asOfInput, "source as-of input");
    if (asOfInput && !inputIds.has(asOfInput)) throw new Error(`Finny SOP source as-of input ${asOfInput} is unknown`);
    return Object.freeze({
      id: sopText(source.id, "source ID"),
      system: sopText(source.system, "source system"),
      object: sopText(source.object, "source object"),
      fields: frozenArray(sopStringArray(source.fields, "source fields")),
      filter: sopText(source.filter, "source filter"),
      ...(asOfInput ? { asOfInput } : {}),
    });
  });
  if (!sources.length) throw new Error("Finny SOP must declare a source");
  uniqueIds(sources, "source");
  const readable = new Set([...inputIds, ...sources.map((source) => source.id)]);
  const steps = sopArray(root.steps, "steps").map((item) => {
    const step = exact(item, ["id", "action", "reads", "writes"], "step");
    const reads = sopStringArray(step.reads, "step reads");
    const unknown = reads.find((read) => !readable.has(read));
    if (unknown) throw new Error(`Finny SOP step read ${unknown} is unknown or out of order`);
    const writes = sopText(step.writes, "step writes");
    if (readable.has(writes)) throw new Error(`Finny SOP step write ${writes} is ambiguous`);
    readable.add(writes);
    return Object.freeze({
      id: sopText(step.id, "step ID"),
      action: sopText(step.action, "step action"),
      reads: frozenArray(reads),
      writes,
    });
  });
  if (!steps.length) throw new Error("Finny SOP must declare an ordered step");
  uniqueIds(steps, "step");
  const outputs = sopArray(root.outputs, "outputs").map((item) => {
    const output = exact(item, ["id", "kind", "contract", "rerun"], "output");
    const rerun =
      output.rerun === undefined
        ? undefined
        : (() => {
            const value = exact(output.rerun, ["inputIds"], "output rerun");
            const inputIdsValue = sopStringArray(value.inputIds, "output rerun input IDs");
            const unknown = inputIdsValue.find((id) => !inputIds.has(id));
            if (unknown) throw new Error(`Finny SOP output rerun input ${unknown} is unknown`);
            return Object.freeze({ inputIds: frozenArray(inputIdsValue) });
          })();
    return Object.freeze({
      id: sopText(output.id, "output ID"),
      kind: enumValue(output.kind, ["xlsx", "summary", "app"] as const, "output kind"),
      contract: jsonValue(output.contract, "output contract") as Record<string, unknown>,
      ...(rerun ? { rerun } : {}),
    });
  });
  if (!outputs.some((output) => output.kind === "xlsx")) throw new Error("Finny SOP must declare an XLSX workbook");
  if (!outputs.some((output) => output.kind === "summary"))
    throw new Error("Finny SOP must declare a certified summary");
  uniqueIds(outputs, "output");
  const evidence = new Set([...readable, ...outputs.map((output) => output.id)]);
  const controls = sopArray(root.controls, "controls").map((item) => {
    const control = exact(item, ["id", "assertion", "tolerance", "evidenceRefs", "judgment"], "control");
    const evidenceRefs = sopStringArray(control.evidenceRefs, "control evidence references");
    const unknown = evidenceRefs.find((reference) => !evidence.has(reference));
    if (unknown) throw new Error(`Finny SOP control evidence reference ${unknown} is unknown`);
    const judgment =
      control.judgment === undefined
        ? undefined
        : (() => {
            const value = exact(control.judgment, ["question", "onlyWhen"], "control judgment");
            return Object.freeze({
              question: sopText(value.question, "control judgment question"),
              onlyWhen: sopText(value.onlyWhen, "control judgment predicate"),
            });
          })();
    return Object.freeze({
      id: sopText(control.id, "control ID"),
      assertion: sopText(control.assertion, "control assertion"),
      ...(control.tolerance === undefined ? {} : { tolerance: sopText(control.tolerance, "control tolerance") }),
      evidenceRefs: frozenArray(evidenceRefs),
      ...(judgment ? { judgment } : {}),
    });
  });
  if (!controls.length) throw new Error("Finny SOP must declare a control");
  uniqueIds(controls, "control");
  const approval = exact(root.approval, ["required", "destination"], "approval");
  return Object.freeze({
    schema: "finny.sop.v1",
    id: sopText(root.id, "ID"),
    version: root.version as number,
    scopeId: sopText(root.scopeId, "scope ID"),
    title: sopText(root.title, "title"),
    intent: Object.freeze({
      domain: enumValue(intent.domain, ["ap", "ar", "gl", "close"] as const, "intent domain"),
      description: sopText(intent.description, "intent description"),
      searchTerms: frozenArray(sopStringArray(intent.searchTerms, "intent search terms")),
    }),
    objective: sopText(root.objective, "objective"),
    inputs: frozenArray(inputs),
    sources: frozenArray(sources),
    steps: frozenArray(steps),
    controls: frozenArray(controls),
    outputs: frozenArray(outputs),
    approval: Object.freeze({
      required: sopBoolean(approval.required, "approval required flag"),
      destination: sopText(approval.destination, "approval destination"),
    }),
  });
}

export function validateFinnySopValues(
  sopValue: unknown,
  value: unknown,
): Record<string, string | boolean> {
  const sop = validateFinnySopVersion(sopValue);
  const values = record(value, "bound input values");
  const inputs = new Map(sop.inputs.map((input) => [input.id, input]));
  const unknown = Object.keys(values).find((key) => !inputs.has(key));
  if (unknown) throw new Error(`Finny SOP bound input ${unknown} is undeclared`);
  const validated: Record<string, string | boolean> = {};
  for (const input of sop.inputs) {
    const bound = values[input.id];
    if (bound === undefined) {
      if (input.required) throw new Error(`Finny SOP required input ${input.id} is missing`);
      continue;
    }
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

export function canonicalFinnyExecutionDigest(
  sopValue: unknown,
  inputValues: unknown,
): string {
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
  const outputNames = sop.outputs.map((output) =>
    output.kind === "xlsx" ? "XLSX workbook" : output.kind === "summary" ? "certified summary" : "app",
  );
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

export function canonicalFinnyPlanDigest(plan: FinnyPlanPresentation): string {
  const validated = validateFinnyPlanPresentation(plan);
  return createHash("sha256").update(JSON.stringify(validated)).digest("base64url");
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

export function assertFinnyMaterialClarificationMatchesPlan(
  plan: FinnyPlanPresentation,
  clarification: FinnyMaterialClarification,
): void {
  const validated = validateFinnyMaterialClarification(clarification);
  const recommended = validated.options.find((option) => option.id === validated.recommendedOptionId);
  const answers = plan.clarifications.filter((answer) => answer.question === validated.question);
  if (answers.length !== 1 || answers[0]?.answer !== recommended?.label)
    throw new Error("Finny clarification does not unambiguously match the immutable plan");
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
  const matches = sop.inputs.filter(
    (input) =>
      input.material &&
      input.from === "human" &&
      (values[input.id] === recommended?.id || values[input.id] === recommended?.label),
  );
  if (matches.length !== 1)
    throw new Error("Finny clarification does not unambiguously match one material SOP input value");
}
