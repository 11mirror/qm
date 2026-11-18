import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFinnyPlanPresentation } from "../src/finny/plan.ts";

const plan = {
  title: "Monthly finance pack",
  summary: "Reconcile and certify the reporting pack",
  phases: [
    { name: "Prepare", owner: "MIS Expert", dependencies: [] },
    { name: "Certify", owner: "Auditor", dependencies: ["Prepare"] },
  ],
  certification: "Independent finance and artifact checks pass",
  deliverable: "Certified workbook",
  destination: "Origin Slack thread",
  clarifications: [
    {
      question: "Which reporting basis applies?",
      answer: "Consolidated group",
    },
  ],
};

test("validates a complete renderable SOP projection", () => {
  const first = validateFinnyPlanPresentation(plan);
  assert.deepEqual(first, plan);
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.phases));
  assert(Object.isFrozen(first.clarifications));
});

test("rejects incomplete plans without imposing presentation caps", () => {
  assert.throws(() => validateFinnyPlanPresentation({ ...plan, deliverable: " " }), /deliverable/i);
  assert.throws(
    () => validateFinnyPlanPresentation({ ...plan, phases: [{ ...plan.phases[0]!, owner: "" }] }),
    /owner/i,
  );
  const manyPhases = Array.from({ length: 80 }, (_, index) => ({
    name: `Phase ${index}`,
    owner: `Owner ${index}`,
    dependencies: index ? [`Phase ${index - 1}`] : [],
  }));
  assert.equal(validateFinnyPlanPresentation({ ...plan, phases: manyPhases }).phases.length, 80);
});
