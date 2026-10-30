import { z } from "zod";

import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor, FinnyIntentDimension } from "./capability-pack.ts";

const CandidateValue = z.union([z.string(), z.array(z.string())]);
const Candidate = z
  .object({
    capabilityId: z.string(),
    dimensions: z.record(z.string(), CandidateValue),
    artifactFormat: z.enum(["json", "csv"]).optional(),
  })
  .strict();

export type FinnyIntentValue = string | readonly string[];

export interface FinnyIntentCandidate {
  capabilityId: string;
  dimensions: Readonly<Record<string, FinnyIntentValue>>;
  artifactFormat?: "json" | "csv";
}

export type FinnyResolvedDimensions = Readonly<Record<string, FinnyIntentValue>>;

export type FinnyIntentResolution =
  | {
      status: "resolved";
      capabilityId: string;
      semanticCapability: string;
      capability: FinnyCapabilityDescriptor;
      dimensions: FinnyResolvedDimensions;
      artifactFormat?: FinnyCapabilityDescriptor["artifactPolicy"]["allowedFormats"][number];
    }
  | {
      status: "invalid_candidate";
      capabilityId?: string;
      issues: readonly string[];
    };

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validString(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes("\0");
}

function dimensionIssue(name: string, declaration: FinnyIntentDimension, value: FinnyIntentValue): string | undefined {
  if (declaration.type === "string_list") {
    if (!Array.isArray(value)) return `dimensions.${name}.type`;
    if (!value.length || new Set(value).size !== value.length || value.some((entry) => !validString(entry)))
      return `dimensions.${name}.type`;
    if (declaration.values && value.some((entry) => !declaration.values!.includes(entry)))
      return `dimensions.${name}.value`;
    return undefined;
  }
  if (typeof value !== "string" || !validString(value)) return `dimensions.${name}.type`;
  if (declaration.type === "date" && !validDate(value)) return `dimensions.${name}.date`;
  if (declaration.type === "enum" && !declaration.values.includes(value)) return `dimensions.${name}.value`;
  return undefined;
}

function candidateShapeIssues(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["candidate.type"];
  const keys = Object.keys(input);
  const declared = new Set(["capabilityId", "dimensions", "artifactFormat"]);
  const extra = keys.filter((key) => !declared.has(key)).sort();
  if (extra.length) return extra.map((key) => `candidate.${key}.undeclared`);
  const parsed = Candidate.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    if (issue.path[0] === "artifactFormat") return "artifactFormat.invalid";
    if (issue.path[0] === "capabilityId") return "capabilityId.type";
    if (issue.path[0] === "dimensions") return "dimensions.type";
    return "candidate.type";
  });
}

export function resolveFinnyIntent(input: unknown, catalog: FinnyCapabilityCatalog): FinnyIntentResolution {
  const shapeIssues = candidateShapeIssues(input);
  if (shapeIssues.length) return { status: "invalid_candidate", issues: [...new Set(shapeIssues)].sort() };
  const candidate = Candidate.parse(input);
  const capability = [...catalog.capabilities.values()].find((entry) => entry.capabilityId === candidate.capabilityId);
  if (!capability)
    return { status: "invalid_candidate", capabilityId: candidate.capabilityId, issues: ["capabilityId.unknown"] };
  if (!capability.intent)
    return {
      status: "invalid_candidate",
      capabilityId: candidate.capabilityId,
      issues: ["capability.intent_schema"],
    };
  if (capability.approvalPolicy.mode !== "before_source")
    return {
      status: "invalid_candidate",
      capabilityId: candidate.capabilityId,
      issues: ["capability.approval_policy"],
    };

  const dimensions: Record<string, FinnyIntentValue> = { ...capability.dimensions.defaults, ...candidate.dimensions };
  const declarations = capability.intent.dimensions;
  const issues = Object.keys(candidate.dimensions)
    .filter((name) => !declarations[name])
    .map((name) => `dimensions.${name}.undeclared`);
  for (const required of capability.dimensions.required)
    if (!Object.hasOwn(dimensions, required)) issues.push(`dimensions.${required}.required`);
  for (const [name, value] of Object.entries(dimensions)) {
    const declaration = declarations[name];
    if (!declaration) continue;
    const issue = dimensionIssue(name, declaration, value);
    if (issue) issues.push(issue);
  }
  if (candidate.artifactFormat && !capability.artifactPolicy.allowedFormats.includes(candidate.artifactFormat))
    issues.push("artifactFormat.invalid");
  if (dimensions.artifact === "required" && capability.artifactPolicy.attachment === "never")
    issues.push("artifact.attachment");
  if (issues.length)
    return {
      status: "invalid_candidate",
      capabilityId: candidate.capabilityId,
      issues: [...new Set(issues)].sort(),
    };

  return {
    status: "resolved",
    capabilityId: capability.capabilityId,
    semanticCapability: capability.semanticCapability,
    capability,
    dimensions: Object.fromEntries(Object.entries(dimensions).sort(([left], [right]) => left.localeCompare(right))),
    ...(candidate.artifactFormat ? { artifactFormat: candidate.artifactFormat } : {}),
  };
}
