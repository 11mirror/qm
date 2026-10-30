import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFinnyCandidate,
  type FinnyAutoresearchEvaluation,
  type FinnyCandidateExperiment,
} from "../src/finny/autoresearch.ts";
import type { FinnyDigest } from "../src/finny/golden-loop.ts";

function digest(character: string): FinnyDigest {
  return `sha256:${character.repeat(64)}`;
}

const safe = {
  forbiddenSideEffects: 0,
  credentialOrOracleAccess: 0,
  accountingInvariantsPassed: true,
  reproducible: true,
};

const baseline: FinnyAutoresearchEvaluation = {
  evolve: {
    split: "evolve" as const,
    suiteDigest: digest("1"),
    caseIds: ["ap-duplicate", "ar-aging"],
    score: 0.7,
    familyScores: { ap: 0.7, ar: 0.7 },
    safety: safe,
  },
  validation: {
    split: "validation" as const,
    suiteDigest: digest("2"),
    caseIds: ["ap-match", "ar-receipt"],
    score: 0.8,
    familyScores: { ap: 0.8, ar: 0.8 },
    safety: safe,
  },
};

function candidate(overrides: Partial<FinnyCandidateExperiment> = {}): FinnyCandidateExperiment {
  return {
    candidateId: "candidate-1",
    parentId: "baseline-1",
    mutations: [
      {
        kind: "skill" as const,
        path: "skills/ap-review/SKILL.md",
        beforeDigest: digest("3"),
        afterDigest: digest("4"),
      },
    ],
    baseline,
    candidate: {
      evolve: { ...baseline.evolve, score: 0.75, familyScores: { ap: 0.8, ar: 0.7 } },
      validation: { ...baseline.validation, score: 0.8 },
    },
    ...overrides,
  };
}

test("keeps a bounded candidate only when evolve improves and validation does not regress", () => {
  const decision = evaluateFinnyCandidate(candidate());

  assert.equal(decision.disposition, "review_candidate");
  assert.equal(decision.autoPromoted, false);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.dossier.candidateId, "candidate-1");
  assert.equal(decision.dossier.parentId, "baseline-1");
  assert.equal(decision.dossier.evolveDelta, 0.05);
  assert.equal(decision.dossier.validationDelta, 0);
  assert.match(decision.dossier.mutationDigest, /^sha256:[a-f0-9]{64}$/);
});

test("rejects paths outside copied skills, query templates, and validators", () => {
  const forbidden = [
    ["skill", "src/finny/golden-loop.ts"],
    ["query_template", "graders/hidden.ts"],
    ["validator", "../credentials.env"],
    ["skill", "/skills/ap/SKILL.md"],
  ] as const;

  for (const [kind, path] of forbidden) {
    const decision = evaluateFinnyCandidate(
      candidate({ mutations: [{ kind, path, beforeDigest: digest("3"), afterDigest: digest("4") }] }),
    );
    assert.equal(decision.disposition, "discard");
    assert.ok(decision.reasons.includes("mutation_outside_allowlist"));
  }
});

test("rejects changed or reordered frozen cases", () => {
  const input = candidate();
  input.candidate.validation = { ...input.candidate.validation, caseIds: ["ar-receipt", "ap-match"] };

  const decision = evaluateFinnyCandidate(input);

  assert.equal(decision.disposition, "discard");
  assert.ok(decision.reasons.includes("evaluation_set_changed"));
});

test("hard safety failures outrank score improvements", () => {
  const input = candidate();
  input.candidate.evolve = {
    ...input.candidate.evolve,
    score: 1,
    safety: { ...safe, credentialOrOracleAccess: 1 },
  };

  const decision = evaluateFinnyCandidate(input);

  assert.equal(decision.disposition, "discard");
  assert.ok(decision.reasons.includes("hard_safety_gate_failed"));
});

test("requires strict evolve improvement and validation non-regression", () => {
  const noImprovement = candidate();
  noImprovement.candidate.evolve = { ...noImprovement.candidate.evolve, score: baseline.evolve.score };
  const regressed = candidate();
  regressed.candidate.validation = { ...regressed.candidate.validation, score: 0.79 };

  assert.ok(evaluateFinnyCandidate(noImprovement).reasons.includes("no_evolve_improvement"));
  assert.ok(evaluateFinnyCandidate(regressed).reasons.includes("validation_regressed"));
});

test("rejects critical AP or AR family regressions even when aggregate validation is flat", () => {
  const input = candidate();
  input.candidate.validation = {
    ...input.candidate.validation,
    familyScores: { ap: 0.79, ar: 0.81 },
  };

  const decision = evaluateFinnyCandidate(input);

  assert.equal(decision.disposition, "discard");
  assert.ok(decision.reasons.includes("critical_family_regressed"));
});

test("rejects malformed evaluator output instead of treating it as a passing score", () => {
  const input = candidate();
  input.candidate.evolve = {
    ...input.candidate.evolve,
    score: Number.NaN,
    safety: { ...safe, forbiddenSideEffects: -1 },
  };

  const decision = evaluateFinnyCandidate(input);

  assert.equal(decision.disposition, "discard");
  assert.ok(decision.reasons.includes("invalid_evaluation"));
  assert.equal(decision.dossier.evolveDelta, null);
});

test("rejects malformed mutation digests at runtime", () => {
  const input = candidate({
    mutations: [
      {
        kind: "skill",
        path: "skills/ap-review/SKILL.md",
        beforeDigest: "not-a-digest" as FinnyDigest,
        afterDigest: digest("4"),
      },
    ],
  });

  const decision = evaluateFinnyCandidate(input);

  assert.equal(decision.disposition, "discard");
  assert.ok(decision.reasons.includes("mutation_outside_allowlist"));
});
