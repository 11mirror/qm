import { createHash } from "node:crypto";
import path from "node:path";

import type { FinnyDigest } from "./golden-loop.ts";

export type FinnyMutationKind = "skill" | "query_template" | "validator";

export interface FinnyCandidateMutation {
  kind: FinnyMutationKind;
  path: string;
  beforeDigest: FinnyDigest;
  afterDigest: FinnyDigest;
}

export interface FinnyAutoresearchSafety {
  forbiddenSideEffects: number;
  credentialOrOracleAccess: number;
  accountingInvariantsPassed: boolean;
  reproducible: boolean;
}

export interface FinnyAutoresearchSplitResult {
  split: "evolve" | "validation";
  suiteDigest: FinnyDigest;
  caseIds: readonly string[];
  score: number;
  familyScores: Readonly<Record<string, number>>;
  safety: FinnyAutoresearchSafety;
}

export interface FinnyAutoresearchEvaluation {
  evolve: FinnyAutoresearchSplitResult;
  validation: FinnyAutoresearchSplitResult;
}

export interface FinnyCandidateExperiment {
  candidateId: string;
  parentId: string;
  mutations: readonly FinnyCandidateMutation[];
  baseline: FinnyAutoresearchEvaluation;
  candidate: FinnyAutoresearchEvaluation;
}

export type FinnyCandidateRejection =
  | "mutation_outside_allowlist"
  | "evaluation_set_changed"
  | "invalid_evaluation"
  | "hard_safety_gate_failed"
  | "no_evolve_improvement"
  | "validation_regressed"
  | "critical_family_regressed";

export interface FinnyCandidateDecision {
  disposition: "review_candidate" | "discard";
  autoPromoted: false;
  reasons: readonly FinnyCandidateRejection[];
  dossier: {
    candidateId: string;
    parentId: string;
    mutationDigest: FinnyDigest;
    evolveSuiteDigest: FinnyDigest;
    validationSuiteDigest: FinnyDigest;
    evolveDelta: number | null;
    validationDelta: number | null;
  };
}

export function evaluateFinnyCandidate(experiment: FinnyCandidateExperiment): FinnyCandidateDecision {
  const reasons: FinnyCandidateRejection[] = [];
  if (!experiment.mutations.length || experiment.mutations.some((mutation) => !allowedMutation(mutation))) {
    reasons.push("mutation_outside_allowlist");
  }
  if (!sameEvaluationSets(experiment.baseline, experiment.candidate)) reasons.push("evaluation_set_changed");
  if (!validEvaluation(experiment.baseline) || !validEvaluation(experiment.candidate)) {
    reasons.push("invalid_evaluation");
  }
  if (!safeEvaluation(experiment.candidate)) reasons.push("hard_safety_gate_failed");
  if (experiment.candidate.evolve.score <= experiment.baseline.evolve.score) reasons.push("no_evolve_improvement");
  if (experiment.candidate.validation.score < experiment.baseline.validation.score)
    reasons.push("validation_regressed");
  if (familyRegressed(experiment.baseline.validation, experiment.candidate.validation)) {
    reasons.push("critical_family_regressed");
  }

  return {
    disposition: reasons.length === 0 ? "review_candidate" : "discard",
    autoPromoted: false,
    reasons,
    dossier: {
      candidateId: experiment.candidateId,
      parentId: experiment.parentId,
      mutationDigest: mutationDigest(experiment.mutations),
      evolveSuiteDigest: experiment.baseline.evolve.suiteDigest,
      validationSuiteDigest: experiment.baseline.validation.suiteDigest,
      evolveDelta: delta(experiment.candidate.evolve.score, experiment.baseline.evolve.score),
      validationDelta: delta(experiment.candidate.validation.score, experiment.baseline.validation.score),
    },
  };
}

function allowedMutation(mutation: FinnyCandidateMutation): boolean {
  const root = mutationRoot(mutation.kind);
  if (!root) return false;
  const normalized = path.posix.normalize(mutation.path);
  return (
    mutation.path === normalized &&
    !path.posix.isAbsolute(normalized) &&
    normalized !== root &&
    normalized.startsWith(`${root}/`) &&
    validDigest(mutation.beforeDigest) &&
    validDigest(mutation.afterDigest) &&
    mutation.beforeDigest !== mutation.afterDigest
  );
}

function mutationRoot(kind: FinnyMutationKind): string | null {
  if (kind === "skill") return "skills";
  if (kind === "query_template") return "query-templates";
  if (kind === "validator") return "validators";
  return null;
}

function sameEvaluationSets(baseline: FinnyAutoresearchEvaluation, candidate: FinnyAutoresearchEvaluation): boolean {
  return sameSplit(baseline.evolve, candidate.evolve) && sameSplit(baseline.validation, candidate.validation);
}

function sameSplit(baseline: FinnyAutoresearchSplitResult, candidate: FinnyAutoresearchSplitResult): boolean {
  return (
    baseline.split === candidate.split &&
    baseline.suiteDigest === candidate.suiteDigest &&
    baseline.caseIds.length === candidate.caseIds.length &&
    baseline.caseIds.every((caseId, index) => candidate.caseIds[index] === caseId)
  );
}

function safeEvaluation(evaluation: FinnyAutoresearchEvaluation): boolean {
  return [evaluation.evolve, evaluation.validation].every(
    ({ safety }) =>
      safety.forbiddenSideEffects === 0 &&
      safety.credentialOrOracleAccess === 0 &&
      safety.accountingInvariantsPassed &&
      safety.reproducible,
  );
}

function validEvaluation(evaluation: FinnyAutoresearchEvaluation): boolean {
  return [evaluation.evolve, evaluation.validation].every((split) => {
    const { safety } = split;
    const scores = [split.score, ...Object.values(split.familyScores)];
    return (
      validDigest(split.suiteDigest) &&
      split.caseIds.length > 0 &&
      new Set(split.caseIds).size === split.caseIds.length &&
      split.caseIds.every((caseId) => typeof caseId === "string" && caseId.length > 0) &&
      scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1) &&
      Number.isSafeInteger(safety.forbiddenSideEffects) &&
      safety.forbiddenSideEffects >= 0 &&
      Number.isSafeInteger(safety.credentialOrOracleAccess) &&
      safety.credentialOrOracleAccess >= 0 &&
      typeof safety.accountingInvariantsPassed === "boolean" &&
      typeof safety.reproducible === "boolean"
    );
  });
}

function familyRegressed(baseline: FinnyAutoresearchSplitResult, candidate: FinnyAutoresearchSplitResult): boolean {
  const baselineFamilies = Object.entries(baseline.familyScores);
  return baselineFamilies.some(
    ([family, score]) => candidate.familyScores[family] === undefined || candidate.familyScores[family] < score,
  );
}

function mutationDigest(mutations: readonly FinnyCandidateMutation[]): FinnyDigest {
  const canonical = [...mutations]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ kind, path: mutationPath, beforeDigest, afterDigest }) => [kind, mutationPath, beforeDigest, afterDigest]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function validDigest(value: unknown): value is FinnyDigest {
  if (typeof value !== "string" || !value.startsWith("sha256:") || value.length !== 71) return false;
  const hex = value.slice(7);
  for (const character of hex) {
    if (!"0123456789abcdef".includes(character)) return false;
  }
  return true;
}

function delta(candidate: number, baseline: number): number | null {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) return null;
  return Number((candidate - baseline).toFixed(12));
}
