import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { slackBotManifestCreationUrl } from "../../src/surfaces/slack-manifest.ts";

const manifestFromUrl = (
  url: string,
): { display_information: { name: string }; features: { bot_user: { display_name: string } } } =>
  JSON.parse(new URL(url).searchParams.get("manifest_json") ?? "{}");

test("the admin Slack app creation link defaults to qm and adopts a configured name", () => {
  const dflt = manifestFromUrl(slackBotManifestCreationUrl());
  assert.equal(dflt.display_information.name, "qm");
  assert.equal(dflt.features.bot_user.display_name, "qm");

  const named = manifestFromUrl(slackBotManifestCreationUrl("straylight"));
  assert.equal(named.display_information.name, "straylight");
  assert.equal(named.features.bot_user.display_name, "straylight");

  const long = manifestFromUrl(slackBotManifestCreationUrl("x".repeat(40)));
  assert.equal(long.display_information.name.length, 35);
});

test("a tenant's Slack app creation link points events and interactivity at its own host and turns Socket Mode off", () => {
  const manifest = JSON.parse(
    new URL(slackBotManifestCreationUrl("acme", "https://acme.example.test")).searchParams.get("manifest_json") ?? "{}",
  ) as {
    settings: {
      event_subscriptions: { request_url?: string };
      interactivity: { request_url?: string };
      socket_mode_enabled: boolean;
    };
  };
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://acme.example.test/slack/events");
  assert.equal(manifest.settings.interactivity.request_url, "https://acme.example.test/slack/interactions");
  assert.equal(manifest.settings.socket_mode_enabled, false);
  const home = JSON.parse(new URL(slackBotManifestCreationUrl("qm")).searchParams.get("manifest_json") ?? "{}") as {
    settings: { socket_mode_enabled: boolean };
  };
  assert.equal(home.settings.socket_mode_enabled, true);
});

test("membership events invalidate the pushed authorization roster", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8"),
  ) as {
    settings?: { event_subscriptions?: { bot_events?: string[] } };
  };
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes("member_joined_channel"));
  assert.ok(events.includes("member_left_channel"));
});
