import { createHash } from "node:crypto";

import type {
  FinnyCapabilityDescriptor,
  FinnyCapabilityOperation,
  FinnySuiteqlSelectOperation,
} from "./capability-pack.ts";
import { canonicalFinnyJson } from "./canonical-json.ts";

export type FinnyOperationScalar = string | number | boolean | null;
export type FinnyOperationParameter = FinnyOperationScalar;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export interface FinnyOperationCompilerInput {
  descriptor: FinnyCapabilityDescriptor;
  manifestDigest: `sha256:${string}`;
  catalogDigest: `sha256:${string}`;
  semanticCapability: string;
  dimensions: Readonly<Record<string, unknown>>;
  artifactFormat?: FinnyCapabilityDescriptor["artifactPolicy"]["allowedFormats"][number];
}

export type FinnyCompiledSuiteqlOperation = DeepReadonly<Omit<FinnySuiteqlSelectOperation, "sql"> & { sql: string }>;
export type FinnyCompiledOperation =
  FinnyCompiledSuiteqlOperation | DeepReadonly<Exclude<FinnyCapabilityOperation, FinnySuiteqlSelectOperation>>;

export interface FinnyOperationPlan {
  readonly schema: "finny.operation_plan.v1";
  readonly capabilityId: string;
  readonly revisionId: string;
  readonly semanticCapability: string;
  readonly manifestDigest: `sha256:${string}`;
  readonly catalogDigest: `sha256:${string}`;
  readonly dimensions: DeepReadonly<Record<string, unknown>>;
  readonly dimensionsDigest: `sha256:${string}`;
  readonly parameterValues: Readonly<Record<string, FinnyOperationParameter>>;
  readonly operations: readonly FinnyCompiledOperation[];
  readonly resultOperationId: string;
  readonly operationGraphDigest: `sha256:${string}`;
  readonly artifactPolicy: DeepReadonly<FinnyCapabilityDescriptor["artifactPolicy"]>;
  readonly artifactPolicyDigest: `sha256:${string}`;
  readonly approvalPolicy: DeepReadonly<FinnyCapabilityDescriptor["approvalPolicy"]>;
  readonly approvalPolicyDigest: `sha256:${string}`;
  readonly verificationPolicy: DeepReadonly<FinnyCapabilityDescriptor["verificationPolicy"]>;
  readonly verificationPolicyDigest: `sha256:${string}`;
  readonly planDigest: `sha256:${string}`;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const PLAN_KEYS = new Set([
  "schema",
  "capabilityId",
  "revisionId",
  "semanticCapability",
  "manifestDigest",
  "catalogDigest",
  "dimensions",
  "dimensionsDigest",
  "parameterValues",
  "operations",
  "resultOperationId",
  "operationGraphDigest",
  "artifactPolicy",
  "artifactPolicyDigest",
  "approvalPolicy",
  "approvalPolicyDigest",
  "verificationPolicy",
  "verificationPolicyDigest",
]);

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalFinnyJson(value)).digest("hex")}`;
}

function bytesDigest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compileDimensions(
  descriptor: FinnyCapabilityDescriptor,
  supplied: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const supported = descriptor.dimensions.supported;
  const requiredDimensions = new Set(descriptor.dimensions.required);
  const allowed = new Set([...descriptor.dimensions.required, ...Object.keys(supported)]);
  for (const required of descriptor.dimensions.required)
    if (!Object.hasOwn(supplied, required)) throw new Error(`Finny dimension ${required} is required`);

  const result: Record<string, unknown> = {};
  for (const name of Object.keys(supplied).sort()) {
    if (!allowed.has(name)) throw new Error(`Finny dimension ${name} is unsupported`);
    const value = supplied[name];
    validateDimensionValue(name, value, new Set());
    if (requiredDimensions.has(name) && Array.isArray(value) && value.length === 0)
      throw new Error(`Finny dimension ${name} is required`);
    const values = supported[name];
    const choices = dimensionChoices(value);
    if (values && (choices === undefined || choices.some((choice) => !values.includes(choice))))
      throw new Error(`Finny dimension ${name} value ${(choices ?? []).join(",") || "unknown"} is unsupported`);
    result[name] = clone(value);
  }
  return result;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validateDimensionValue(name: string, value: unknown, ancestors: Set<object>): void {
  if (typeof value === "string") {
    if (!value || value !== value.trim() || value.includes("\0"))
      throw new Error(`Finny dimension ${name} contains a non-normalized string`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      throw new Error(`Finny dimension ${name} contains an ambiguous number`);
    return;
  }
  if (typeof value === "boolean") return;
  if (!Array.isArray(value) && !plainRecord(value))
    throw new Error(`Finny dimension ${name} contains unsupported data`);
  if (ancestors.has(value)) throw new Error(`Finny dimension ${name} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) validateDimensionValue(name, nested, ancestors);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Finny dimension ${name} contains an invalid field`);
      validateDimensionValue(name, nested, ancestors);
    }
  }
  ancestors.delete(value);
}

function dimensionChoices(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (plainRecord(value) && typeof value.kind === "string") return [value.kind];
  return undefined;
}

function parameterNames(operations: readonly FinnyCapabilityOperation[]): Set<string> {
  const names = new Set<string>();
  for (const operation of operations) {
    if (operation.primitive === "suiteql_select") for (const parameter of operation.parameters) names.add(parameter);
  }
  return names;
}

function scalarParameter(name: string, value: unknown): FinnyOperationScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Finny parameter ${name} must be finite`);
    if (Object.is(value, -0)) throw new Error(`Finny parameter ${name} must be an unambiguous scalar`);
    return value;
  }
  throw new Error(`Finny parameter ${name} must be a scalar string, number, boolean, or null`);
}

function compileParameters(
  descriptor: FinnyCapabilityDescriptor,
  dimensions: Readonly<Record<string, unknown>>,
): Record<string, FinnyOperationParameter> {
  const required = parameterNames(descriptor.operations);
  const bindings = descriptor.parameterBindings;
  for (const name of required)
    if (!Object.hasOwn(bindings, name)) throw new Error(`Finny parameter binding ${name} is required`);
  for (const name of Object.keys(bindings))
    if (!required.has(name)) throw new Error(`Finny parameter binding ${name} is unexpected`);

  const result: Record<string, FinnyOperationParameter> = {};
  for (const name of [...required].sort()) {
    const binding = bindings[name]!;
    const value = binding.source === "literal" ? binding.value : dimensionBinding(name, binding.path, dimensions);
    result[name] = scalarParameter(name, value);
  }
  return result;
}

function dimensionBinding(
  name: string,
  path: readonly string[],
  dimensions: Readonly<Record<string, unknown>>,
): unknown {
  let value: unknown = dimensions;
  for (const segment of path) {
    if (!plainRecord(value) || !Object.hasOwn(value, segment))
      throw new Error(`Finny parameter ${name} dimension path ${path.join(".")} is unavailable`);
    value = value[segment];
  }
  return value;
}

function sqlLiteral(name: string, value: FinnyOperationScalar): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value.includes("\0")) throw new Error(`Finny parameter ${name} contains an invalid null character`);
  return `'${value.replaceAll("'", "''")}'`;
}

function renderSuiteql(
  operation: FinnySuiteqlSelectOperation,
  values: Readonly<Record<string, FinnyOperationParameter>>,
): string {
  let rendered = "";
  let index = 0;
  while (index < operation.sql.length) {
    const character = operation.sql[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      rendered += character;
      index += 1;
      while (index < operation.sql.length) {
        const quoted = operation.sql[index]!;
        rendered += quoted;
        index += 1;
        if (quoted === quote) {
          if (operation.sql[index] === quote) {
            rendered += quote;
            index += 1;
          } else break;
        }
      }
      continue;
    }
    if (character === ":") {
      const match = /^:([a-z][a-z0-9_]*)/.exec(operation.sql.slice(index));
      if (!match) throw new Error(`Finny operation ${operation.id} has an invalid named parameter`);
      const name = match[1]!;
      if (!Object.hasOwn(values, name)) throw new Error(`Finny parameter ${name} is required`);
      const value = values[name]!;
      rendered += sqlLiteral(name, value);
      index += match[0].length;
      continue;
    }
    rendered += character;
    index += 1;
  }
  return rendered;
}

function compileOperations(
  operations: readonly FinnyCapabilityOperation[],
  parameters: Readonly<Record<string, FinnyOperationParameter>>,
): FinnyCompiledOperation[] {
  return operations.map((operation) =>
    operation.primitive === "suiteql_select"
      ? { ...clone(operation), sql: renderSuiteql(operation, parameters) }
      : clone(operation),
  );
}

export function compileFinnyOperationPlan(input: FinnyOperationCompilerInput): FinnyOperationPlan {
  if (!DIGEST.test(input.manifestDigest)) throw new Error("Finny manifest digest is invalid");
  if (!DIGEST.test(input.catalogDigest)) throw new Error("Finny catalog digest is invalid");
  if (input.semanticCapability !== input.descriptor.semanticCapability)
    throw new Error("Finny semantic capability does not match the reviewed descriptor");
  if (input.artifactFormat && !input.descriptor.artifactPolicy.allowedFormats.includes(input.artifactFormat))
    throw new Error(`Finny artifact format ${input.artifactFormat} is unsupported`);

  const dimensions = compileDimensions(input.descriptor, input.dimensions);
  const dimensionsDigest = digest(dimensions);
  const parameterValues = compileParameters(input.descriptor, dimensions);
  const operations = compileOperations(input.descriptor.operations, parameterValues);
  const operationGraphDigest = digest({
    operations: input.descriptor.operations,
    parameterBindings: input.descriptor.parameterBindings,
  });
  const artifactPolicy = {
    ...clone(input.descriptor.artifactPolicy),
    defaultFormat: input.artifactFormat ?? input.descriptor.artifactPolicy.defaultFormat,
  };
  const approvalPolicy = clone(input.descriptor.approvalPolicy);
  const verificationPolicy = clone(input.descriptor.verificationPolicy);
  const unsigned = {
    schema: "finny.operation_plan.v1" as const,
    capabilityId: input.descriptor.capabilityId,
    revisionId: input.descriptor.revisionId,
    semanticCapability: input.descriptor.semanticCapability,
    manifestDigest: input.manifestDigest,
    catalogDigest: input.catalogDigest,
    dimensions,
    dimensionsDigest,
    parameterValues,
    operations,
    resultOperationId: input.descriptor.resultOperationId,
    operationGraphDigest,
    artifactPolicy,
    artifactPolicyDigest: digest(artifactPolicy),
    approvalPolicy,
    approvalPolicyDigest: digest(approvalPolicy),
    verificationPolicy,
    verificationPolicyDigest: digest(verificationPolicy),
  };
  return deepFreeze({ ...unsigned, planDigest: digest(unsigned) });
}

export function encodeFinnyOperationPlan(plan: FinnyOperationPlan): Buffer {
  const { planDigest, ...unsigned } = plan;
  const bytes = Buffer.from(canonicalFinnyJson(unsigned), "utf8");
  if (bytesDigest(bytes) !== planDigest) throw new Error("Finny operation plan digest does not match its bytes");
  return bytes;
}

function operationPlanRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Finny operation plan is invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PLAN_KEYS.size || keys.some((key) => !PLAN_KEYS.has(key)))
    throw new Error("Finny operation plan is invalid");
  return record;
}

function assertDecodedPlan(record: Record<string, unknown>): asserts record is Omit<FinnyOperationPlan, "planDigest"> {
  if (
    record.schema !== "finny.operation_plan.v1" ||
    typeof record.capabilityId !== "string" ||
    !IDENTIFIER.test(record.capabilityId) ||
    typeof record.revisionId !== "string" ||
    typeof record.semanticCapability !== "string" ||
    !IDENTIFIER.test(record.semanticCapability) ||
    typeof record.manifestDigest !== "string" ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.catalogDigest !== "string" ||
    !DIGEST.test(record.catalogDigest) ||
    !plainRecord(record.dimensions) ||
    typeof record.dimensionsDigest !== "string" ||
    !DIGEST.test(record.dimensionsDigest) ||
    digest(record.dimensions) !== record.dimensionsDigest ||
    !plainRecord(record.parameterValues) ||
    !Array.isArray(record.operations) ||
    record.operations.length === 0 ||
    typeof record.resultOperationId !== "string" ||
    typeof record.operationGraphDigest !== "string" ||
    !DIGEST.test(record.operationGraphDigest) ||
    !plainRecord(record.artifactPolicy) ||
    typeof record.artifactPolicyDigest !== "string" ||
    !DIGEST.test(record.artifactPolicyDigest) ||
    digest(record.artifactPolicy) !== record.artifactPolicyDigest ||
    !plainRecord(record.approvalPolicy) ||
    typeof record.approvalPolicyDigest !== "string" ||
    !DIGEST.test(record.approvalPolicyDigest) ||
    digest(record.approvalPolicy) !== record.approvalPolicyDigest ||
    !plainRecord(record.verificationPolicy) ||
    typeof record.verificationPolicyDigest !== "string" ||
    !DIGEST.test(record.verificationPolicyDigest) ||
    digest(record.verificationPolicy) !== record.verificationPolicyDigest
  )
    throw new Error("Finny operation plan is invalid");
  for (const [name, value] of Object.entries(record.parameterValues)) scalarParameter(name, value);
  const operationIds = new Set<string>();
  for (const candidate of record.operations) {
    if (!plainRecord(candidate)) throw new Error("Finny operation plan is invalid");
    const id = candidate.id;
    const primitive = candidate.primitive;
    const dependsOn = candidate.dependsOn;
    if (
      typeof id !== "string" ||
      !IDENTIFIER.test(id) ||
      operationIds.has(id) ||
      typeof primitive !== "string" ||
      !["suiteql_select", "repeat_pull", "reconcile"].includes(primitive) ||
      !Array.isArray(dependsOn) ||
      dependsOn.some((dependency) => typeof dependency !== "string" || !operationIds.has(dependency))
    )
      throw new Error("Finny operation plan is invalid");
    operationIds.add(id);
  }
  if (!operationIds.has(record.resultOperationId)) throw new Error("Finny operation plan result is invalid");
}

export function decodeFinnyOperationPlan(bytes: Uint8Array, expectedDigest: `sha256:${string}`): FinnyOperationPlan {
  if (!DIGEST.test(expectedDigest) || bytesDigest(bytes) !== expectedDigest)
    throw new Error("Finny operation plan digest is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("Finny operation plan is invalid");
  }
  const record = operationPlanRecord(parsed);
  if (Buffer.from(canonicalFinnyJson(record), "utf8").compare(Buffer.from(bytes)) !== 0)
    throw new Error("Finny operation plan encoding is invalid");
  assertDecodedPlan(record);
  return deepFreeze({ ...record, planDigest: expectedDigest });
}
