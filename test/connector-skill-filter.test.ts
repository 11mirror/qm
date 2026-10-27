import test from "node:test";
import assert from "node:assert/strict";
import { filterConnectorSkills } from "../src/core/orchestrator.ts";
import type { SkillResolution } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

function skill(name: string, connector?: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: {
        name,
        description: name,
        requiredCapabilities: connector ? [`connector:${connector}`] : [],
        body: name,
      },
      status: "published",
      createdBy: "test",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
      createdAt: 1,
      updatedAt: 1,
    },
    shadowed: [],
  };
}

test("provider skills are visible only for connectors configured by the admin", () => {
  const all = [
    skill("memory"),
    skill("google-workspace", "google"),
    skill("dropbox", "dropbox"),
    skill("linear", "linear"),
    skill("x", "x"),
    skill("slack-drafts", "slack"),
    skill("zoom", "zoom"),
  ];
  assert.deepEqual(
    filterConnectorSkills(all, []).map((entry) => entry.skill?.manifest.name),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["google", "linear"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "google-workspace", "linear"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["slack"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "slack-drafts"],
  );
});

test("the credential-backed Composio skill needs no dedicated OAuth configuration", () => {
  assert.deepEqual(
    filterConnectorSkills([skill("composio"), skill("google-workspace", "google")], []).map(
      (entry) => entry.skill?.manifest.name,
    ),
    ["composio"],
  );
});
