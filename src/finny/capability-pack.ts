import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";

export const FINNY_OPERATION_PRIMITIVES = Object.freeze(["suiteql_select", "repeat_pull", "reconcile"] as const);

export type FinnyOperationPrimitive = (typeof FINNY_OPERATION_PRIMITIVES)[number];

const Identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const IdentifierList = z.array(Identifier).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "duplicate identifiers" });
});
const OperationBase = {
  id: Identifier,
  dependsOn: IdentifierList,
};
const SuiteqlSelectOperation = z
  .object({
    ...OperationBase,
    primitive: z.literal("suiteql_select"),
    sql: z.string().min(1),
    parameters: IdentifierList,
  })
  .strict();
const ReconcileOperation = z
  .object({
    ...OperationBase,
    primitive: z.literal("reconcile"),
    leftField: Identifier,
    rightField: Identifier,
    tolerance: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
  })
  .strict();
const RepeatPullOperation = z
  .object({ ...OperationBase, primitive: z.literal("repeat_pull"), operationId: Identifier })
  .strict();
const CapabilityOperation = z.discriminatedUnion("primitive", [
  SuiteqlSelectOperation,
  RepeatPullOperation,
  ReconcileOperation,
]);

export type FinnySuiteqlSelectOperation = z.infer<typeof SuiteqlSelectOperation>;
export type FinnyReconcileOperation = z.infer<typeof ReconcileOperation>;
export type FinnyRepeatPullOperation = z.infer<typeof RepeatPullOperation>;
export type FinnyCapabilityOperation = z.infer<typeof CapabilityOperation>;

const ArtifactFormat = z.enum(["json", "csv"]);
const DimensionDefaultValue = z.union([
  z
    .string()
    .min(1)
    .refine((value) => value === value.trim() && !value.includes("\0")),
  z
    .array(
      z
        .string()
        .min(1)
        .refine((value) => value === value.trim() && !value.includes("\0")),
    )
    .min(1),
]);
const ParameterScalar = z.union([
  z.string().refine((value) => !value.includes("\0")),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const ParameterBinding = z.discriminatedUnion("source", [
  z.object({ source: z.literal("dimension"), path: IdentifierList.min(1) }).strict(),
  z
    .object({
      source: z.literal("literal"),
      value: z.union([ParameterScalar, z.array(ParameterScalar).min(1)]),
    })
    .strict(),
]);

export type FinnyParameterBinding = z.infer<typeof ParameterBinding>;

const IntentValue = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !value.includes("\0"));
const IntentDimension = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enum"), values: z.array(IntentValue).min(1) }).strict(),
  z.object({ type: z.literal("string") }).strict(),
  z.object({ type: z.literal("date") }).strict(),
  z.object({ type: z.literal("string_list"), values: z.array(IntentValue).min(1).optional() }).strict(),
]);
const IntentSchema = z.object({ dimensions: z.record(Identifier, IntentDimension) }).strict();

export type FinnyIntentDimension = z.infer<typeof IntentDimension>;

const CapabilityDescriptor = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: Identifier,
    revisionId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9._-]*$/),
    semanticCapability: Identifier,
    semanticAliases: IdentifierList,
    intent: IntentSchema.optional(),
    dimensions: z
      .object({
        required: IdentifierList,
        supported: z.record(Identifier, IdentifierList.min(1)),
        defaults: z.record(Identifier, DimensionDefaultValue),
      })
      .strict(),
    operations: z.array(CapabilityOperation).min(1),
    resultOperationId: Identifier,
    parameterBindings: z.record(Identifier, ParameterBinding),
    artifactPolicy: z
      .object({
        allowedFormats: z
          .array(ArtifactFormat)
          .min(1)
          .superRefine((values, context) => {
            if (new Set(values).size !== values.length)
              context.addIssue({ code: "custom", message: "duplicate artifact formats" });
          }),
        defaultFormat: ArtifactFormat,
        attachment: z.enum(["never", "when_requested", "always"]),
      })
      .strict(),
    approvalPolicy: z
      .object({
        mode: z.enum(["none", "before_source"]),
        binds: z
          .array(z.enum(["capability_revision", "dimensions", "operation_graph"]))
          .superRefine((values, context) => {
            if (new Set(values).size !== values.length)
              context.addIssue({ code: "custom", message: "duplicate approval bindings" });
          }),
      })
      .strict(),
    verificationPolicy: z
      .object({
        requiredOperationIds: IdentifierList,
        releaseGate: z.literal("delivery_eligible"),
      })
      .strict(),
  })
  .strict();

export type FinnyCapabilityDescriptor = z.infer<typeof CapabilityDescriptor>;

export interface FinnyCapabilityCatalog {
  manifestDigest: `sha256:${string}`;
  catalogDigest: `sha256:${string}`;
  capabilities: ReadonlyMap<string, FinnyCapabilityDescriptor>;
  aliases: ReadonlyMap<string, string>;
}

const ManifestFile = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const CapabilityManifest = z
  .object({
    schemaVersion: z.literal(1),
    classification: z.literal("reviewed-finance-capability-pack"),
    capabilities: z.array(z.string().min(1)).min(1),
    files: z.array(ManifestFile).min(1),
  })
  .strict();

type CapabilityManifest = z.infer<typeof CapabilityManifest>;

const FORBIDDEN_SQL_WORDS = new Set([
  "alter",
  "begin",
  "call",
  "commit",
  "copy",
  "create",
  "delete",
  "drop",
  "exec",
  "execute",
  "grant",
  "insert",
  "into",
  "merge",
  "replace",
  "revoke",
  "rollback",
  "truncate",
  "update",
  "upsert",
]);
const REQUIRED_APPROVAL_BINDINGS = ["capability_revision", "dimensions", "operation_graph"] as const;

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parse<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${context} is invalid: ${result.error.message}`);
  return result.data;
}

function unique(values: readonly string[], context: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${context} contains duplicates`);
}

function pathWithin(root: string, relative: string): string {
  if (!relative || relative.includes("\0") || isAbsolute(relative))
    throw new Error("Finny capability manifest path is invalid");
  const absolute = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("Finny capability manifest path escapes the bundle");
  return absolute;
}

async function verifiedPath(root: string, relative: string): Promise<string> {
  const actual = await realpath(pathWithin(root, relative));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!actual.startsWith(prefix)) throw new Error("Finny capability manifest path escapes the bundle");
  return actual;
}

function sqlTokens(sql: string): { words: string[]; parameters: string[] } {
  const words: string[] = [];
  const parameters: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 2;
          else {
            index += 1;
            closed = true;
            break;
          }
        } else index += 1;
      }
      if (!closed) throw new Error("SuiteQL template has an invalid quoted value");
      continue;
    }
    if ((character === "-" && sql[index + 1] === "-") || (character === "/" && sql[index + 1] === "*"))
      throw new Error("SuiteQL template comments are invalid");
    if (character === ";") throw new Error("SuiteQL template must be a single statement");
    if (character === "?" || (character === "$" && /[0-9]/.test(sql[index + 1] ?? "")))
      throw new Error("SuiteQL template parameters must be named host parameters");
    if (character === ":") {
      const match = /^:[a-z][a-z0-9_]*/.exec(sql.slice(index));
      if (!match) throw new Error("SuiteQL template has an invalid named parameter");
      parameters.push(match[0].slice(1));
      index += match[0].length;
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      const match = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(index))!;
      words.push(match[0].toLowerCase());
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  return { words, parameters };
}

function validateSql(operation: FinnySuiteqlSelectOperation): void {
  const tokens = sqlTokens(operation.sql);
  if (
    !tokens.words.length ||
    (tokens.words[0] !== "select" && tokens.words[0] !== "with") ||
    !tokens.words.includes("select")
  )
    throw new Error(`SuiteQL operation ${operation.id} must be a read-only SELECT or WITH statement`);
  const forbidden = tokens.words.find((word) => FORBIDDEN_SQL_WORDS.has(word));
  if (forbidden) throw new Error(`SuiteQL operation ${operation.id} contains non-read-only operation ${forbidden}`);
  const used = new Set(tokens.parameters);
  const declared = new Set(operation.parameters);
  if (
    used.size !== declared.size ||
    [...used].some((parameter) => !declared.has(parameter)) ||
    [...declared].some((parameter) => !used.has(parameter))
  )
    throw new Error(`SuiteQL operation ${operation.id} named parameters do not match the host declaration`);
}

function validateDescriptor(descriptor: FinnyCapabilityDescriptor): void {
  if (descriptor.semanticAliases.includes(descriptor.semanticCapability))
    throw new Error(`Finny capability ${descriptor.capabilityId} aliases its own semantic capability`);
  if (!descriptor.intent) throw new Error(`Finny capability ${descriptor.capabilityId} has no reviewed intent schema`);
  if (!descriptor.artifactPolicy.allowedFormats.includes(descriptor.artifactPolicy.defaultFormat))
    throw new Error(`Finny capability ${descriptor.capabilityId} default artifact format is not allowed`);
  if (descriptor.approvalPolicy.mode !== "before_source")
    throw new Error(`Finny capability ${descriptor.capabilityId} requires approval before source execution`);
  if (REQUIRED_APPROVAL_BINDINGS.some((binding) => !descriptor.approvalPolicy.binds.includes(binding)))
    throw new Error(`Finny capability ${descriptor.capabilityId} approval does not bind the complete reviewed plan`);

  const prior = new Map<string, FinnyCapabilityOperation>();
  const parameterNames = new Set<string>();
  for (const operation of descriptor.operations) {
    if (prior.has(operation.id)) throw new Error(`Finny capability has duplicate operation ${operation.id}`);
    for (const dependency of operation.dependsOn)
      if (!prior.has(dependency))
        throw new Error(`Finny capability operation ${operation.id} has invalid dependency ${dependency}`);
    if (operation.primitive === "suiteql_select") {
      validateSql(operation);
      for (const parameter of operation.parameters) parameterNames.add(parameter);
    }
    if (operation.primitive === "reconcile" && operation.dependsOn.length !== 2)
      throw new Error(`Finny capability operation ${operation.id} dependencies are invalid`);
    if (operation.primitive === "repeat_pull") {
      const repeated = prior.get(operation.operationId);
      if (!repeated || repeated.primitive !== "suiteql_select" || !operation.dependsOn.includes(operation.operationId))
        throw new Error(`Finny capability operation ${operation.id} repeat pull target is invalid`);
    }
    prior.set(operation.id, operation);
  }
  const bindingNames = Object.keys(descriptor.parameterBindings);
  if (
    bindingNames.length !== parameterNames.size ||
    bindingNames.some((name) => !parameterNames.has(name)) ||
    [...parameterNames].some((name) => !Object.hasOwn(descriptor.parameterBindings, name))
  )
    throw new Error(`Finny capability ${descriptor.capabilityId} parameter bindings do not match operations`);
  const dimensionNames = new Set([...descriptor.dimensions.required, ...Object.keys(descriptor.dimensions.supported)]);
  for (const dimension of descriptor.dimensions.required)
    if (!descriptor.intent.dimensions[dimension])
      throw new Error(`Finny required dimension ${dimension} has no intent declaration`);
  for (const [name, value] of Object.entries(descriptor.dimensions.defaults)) {
    const supported = descriptor.dimensions.supported[name];
    const intent = descriptor.intent.dimensions[name];
    if (!dimensionNames.has(name) || !supported || !intent)
      throw new Error(`Finny dimension default ${name} is undeclared`);
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => !supported.includes(entry)))
      throw new Error(`Finny dimension default ${name} is unsupported`);
    if (intent.type === "string_list" && !Array.isArray(value))
      throw new Error(`Finny dimension default ${name} has an invalid intent type`);
    if (intent.type !== "string_list" && Array.isArray(value))
      throw new Error(`Finny dimension default ${name} has an invalid intent type`);
    const intentValues = "values" in intent ? intent.values : undefined;
    if (intentValues && values.some((entry) => !intentValues.includes(entry)))
      throw new Error(`Finny dimension default ${name} is outside its intent declaration`);
  }
  for (const dimension of Object.keys(descriptor.intent.dimensions))
    if (!dimensionNames.has(dimension)) throw new Error(`Finny intent dimension ${dimension} is undeclared`);
  for (const [name, binding] of Object.entries(descriptor.parameterBindings))
    if (binding.source === "dimension" && !dimensionNames.has(binding.path[0]!))
      throw new Error(`Finny parameter binding ${name} has an undeclared dimension root`);
  const resultOperation = prior.get(descriptor.resultOperationId);
  if (!resultOperation || resultOperation.primitive === "repeat_pull" || resultOperation.primitive === "reconcile")
    throw new Error(`Finny capability ${descriptor.capabilityId} result operation is invalid`);
  for (const operationId of descriptor.verificationPolicy.requiredOperationIds)
    if (!prior.has(operationId)) throw new Error(`Finny verification operation ${operationId} is invalid`);
  const resultClosure = dependencyClosure(prior, descriptor.resultOperationId);
  const requiredOperationIds = new Set(descriptor.verificationPolicy.requiredOperationIds);
  const independentRepeats = descriptor.operations.filter(
    (operation) =>
      operation.primitive === "repeat_pull" &&
      requiredOperationIds.has(operation.id) &&
      resultClosure.has(operation.operationId) &&
      !resultClosure.has(operation.id),
  );
  if (!independentRepeats.length)
    throw new Error(`Finny capability ${descriptor.capabilityId} verification requires a result-connected repeat pull`);
  const hasReconciliationControl = descriptor.operations.some(
    (operation) =>
      operation.primitive === "reconcile" &&
      requiredOperationIds.has(operation.id) &&
      dependencyClosure(prior, operation.id).has(descriptor.resultOperationId) &&
      independentRepeats.some((repeat) => dependencyClosure(prior, operation.id).has(repeat.id)),
  );
  if (!hasReconciliationControl)
    throw new Error(`Finny capability ${descriptor.capabilityId} verification requires a reconciliation control path`);
}

function dependencyClosure(
  operations: ReadonlyMap<string, FinnyCapabilityOperation>,
  operationId: string,
): Set<string> {
  const closure = new Set<string>();
  const visit = (id: string): void => {
    if (closure.has(id)) return;
    closure.add(id);
    for (const dependency of operations.get(id)?.dependsOn ?? []) visit(dependency);
  };
  visit(operationId);
  return closure;
}

function parseManifest(value: unknown): CapabilityManifest {
  const manifest = parse(CapabilityManifest, value, "Finny capability manifest");
  unique(manifest.capabilities, "Finny capability manifest capabilities");
  unique(
    manifest.files.map((file) => file.path),
    "Finny capability manifest file paths",
  );
  const paths = new Set(manifest.files.map((file) => file.path));
  for (const capability of manifest.capabilities)
    if (!paths.has(capability)) throw new Error(`Finny capability ${capability} is absent from manifest files`);
  return manifest;
}

function parseDescriptor(value: unknown): FinnyCapabilityDescriptor {
  const descriptor = parse(CapabilityDescriptor, value, "Finny capability descriptor");
  validateDescriptor(descriptor);
  return descriptor;
}

export async function loadFinnyCapabilityPack(directory: string): Promise<FinnyCapabilityCatalog> {
  const root = await realpath(resolve(directory));
  const manifestBytes = await readFile(await verifiedPath(root, "manifest.json"));
  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const manifestDigest = `sha256:${digest(manifestBytes)}` as const;
  const bodies = new Map<string, Buffer>();
  const fileRows: string[] = [];

  for (const file of manifest.files) {
    const path = await verifiedPath(root, file.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== file.size)
      throw new Error(`Finny capability size mismatch: ${file.path}`);
    const bytes = await readFile(path);
    const actualDigest = digest(bytes);
    if (actualDigest !== file.sha256) throw new Error(`Finny capability digest mismatch: ${file.path}`);
    bodies.set(file.path, bytes);
    fileRows.push(`${file.path}\0${file.size}\0${actualDigest}`);
  }

  const capabilities = new Map<string, FinnyCapabilityDescriptor>();
  const aliases = new Map<string, string>();
  const capabilityIds = new Set<string>();
  const revisionIds = new Set<string>();
  const catalogRows: string[] = [];

  for (const path of manifest.capabilities) {
    const descriptor = parseDescriptor(JSON.parse(bodies.get(path)!.toString("utf8")) as unknown);
    if (capabilityIds.has(descriptor.capabilityId))
      throw new Error(`Finny capability pack has duplicate capabilityId ${descriptor.capabilityId}`);
    if (revisionIds.has(descriptor.revisionId))
      throw new Error(`Finny capability pack has duplicate revisionId ${descriptor.revisionId}`);
    if (capabilities.has(descriptor.semanticCapability) || aliases.has(descriptor.semanticCapability))
      throw new Error(`Finny capability pack has duplicate semantic capability ${descriptor.semanticCapability}`);
    capabilityIds.add(descriptor.capabilityId);
    revisionIds.add(descriptor.revisionId);
    capabilities.set(descriptor.semanticCapability, descriptor);
    for (const alias of descriptor.semanticAliases) {
      if (capabilities.has(alias) || aliases.has(alias))
        throw new Error(`Finny capability pack has duplicate alias ${alias}`);
      aliases.set(alias, descriptor.semanticCapability);
    }
    catalogRows.push(
      `${descriptor.semanticCapability}\0${descriptor.capabilityId}\0${descriptor.revisionId}\0${digest(bodies.get(path)!)}`,
    );
  }

  const catalogDigest = `sha256:${digest(
    [manifestDigest, ...fileRows.sort(), ...catalogRows.sort()].join("\n"),
  )}` as const;
  return Object.freeze({ manifestDigest, catalogDigest, capabilities, aliases });
}
