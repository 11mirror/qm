import { readFileSync } from "node:fs";

interface SlackBotManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string } };
  settings: {
    event_subscriptions: { request_url?: string };
    interactivity: { request_url?: string };
    socket_mode_enabled: boolean;
  };
}

let template: string | undefined;

export function slackBotManifestCreationUrl(name?: string, origin?: string): string {
  template ??= readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(template) as SlackBotManifest;
  const label = [...(name?.trim() || "qm")].slice(0, 35).join("");
  manifest.display_information.name = label;
  manifest.display_information.description = `${label} workspace agent`;
  manifest.features.bot_user.display_name = label;
  if (origin) {
    manifest.settings.event_subscriptions.request_url = new URL("/slack/events", origin).href;
    manifest.settings.interactivity.request_url = new URL("/slack/interactions", origin).href;
    manifest.settings.socket_mode_enabled = false;
  }
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}
