import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowDefinitions } from "../src/sessions/workflow-registry.ts";

test("workflow definitions load from the deployment layer with ordered references", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          steps: [
            { id: "evidence", role: "producer", requiredSkills: [] },
            {
              id: "audit",
              role: "auditor",
              after: "evidence",
              separateFrom: "evidence",
              evidenceFrom: "evidence",
              requiredSkills: [
                {
                  skillId: "11111111-1111-4111-8111-111111111111",
                  contentDigest: "a".repeat(64),
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  assert.equal(loadWorkflowDefinitions(dir)[0]?.steps[1]?.id, "audit");
});

test("workflow definitions reject forward references and duplicate ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-invalid-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        {
          id: "finance",
          version: 1,
          steps: [
            { id: "audit", role: "auditor", after: "evidence", requiredSkills: [] },
            { id: "evidence", role: "producer", requiredSkills: [] },
            { id: "evidence", role: "producer", requiredSkills: [] },
          ],
        },
      ],
    }),
  );

  assert.throws(() => loadWorkflowDefinitions(dir), /must reference an earlier step/);
});

test("workflow definitions reject multiple active workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-workflows-multiple-"));
  writeFileSync(
    join(dir, "workflow-gates.json"),
    JSON.stringify({
      workflows: [
        { id: "finance", version: 1, steps: [{ id: "evidence", role: "producer", requiredSkills: [] }] },
        { id: "treasury", version: 1, steps: [{ id: "evidence", role: "producer", requiredSkills: [] }] },
      ],
    }),
  );

  assert.throws(() => loadWorkflowDefinitions(dir), /supports exactly one active workflow/);
});
