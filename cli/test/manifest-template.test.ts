import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSlackManifests } from "../src/slack-manifests.ts";
import type { QmConfig } from "../src/config.ts";

const manifestConfig = (botName?: string): QmConfig =>
  ({
    orgId: "acme",
    publicUrl: "https://qm.example.com",
    ...(botName ? { botName } : {}),
  }) as QmConfig;

test("rendered Slack manifests default to qm naming", () => {
  const { bot, sso } = renderSlackManifests(manifestConfig());
  assert.match(bot, /name: qm\n/);
  assert.match(bot, /display_name: qm\n/);
  assert.match(bot, /description: qm workspace agent for acme\n/);
  assert.match(sso, /name: qm SSO\n/);
  assert.match(sso, /description: Sign in to your qm deployment with Slack\n/);
});

test("botName renames both rendered Slack manifests", () => {
  const { bot, sso } = renderSlackManifests(manifestConfig("straylight"));
  assert.match(bot, /name: straylight\n/);
  assert.match(bot, /display_name: straylight\n/);
  assert.match(bot, /description: straylight workspace agent for acme\n/);
  assert.match(sso, /name: straylight SSO\n/);
  assert.match(sso, /description: Sign in to your straylight deployment with Slack\n/);
  assert.doesNotMatch(bot, /\bqm\b/);
});
