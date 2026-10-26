const LOGS = ["history", "slack", "judgments", "errors", "audit", "egress"];
const ARTIFACTS = ["files", "skills", "memory", "deployments", "crons"];

export const ADMIN_SECTIONS = [
  {
    label: "Organization",
    views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users", "spend"],
  },
  { label: "Logs", views: LOGS },
  { label: "Artifacts", views: ARTIFACTS },
];

export const ADMIN_VIEWS = new Set([
  ...ADMIN_SECTIONS.flatMap((section) => section.views),
  "onboarding",
  "user",
  "ackemoji",
  "keychain",
]);

export const SETTINGS_VIEWS = new Set(["governance", "models", "credentials", "customize", "slack-settings"]);
export const LOG_VIEWS = new Set([...LOGS, "memory"]);
export const SCOPED_VIEWS = new Set([
  "governance",
  ...LOGS.filter((view) => view !== "slack" && view !== "judgments"),
  ...ARTIFACTS,
]);

const TITLES: Record<string, string> = {
  history: "Sessions",
  deployments: "Apps",
  slack: "Slack messages",
  "slack-settings": "Slack",
  ackemoji: "Ack emoji",
};
export const VIEW_TITLE: Record<string, string> = Object.fromEntries(
  ["general", ...ADMIN_VIEWS].map((view) => [view, TITLES[view] || view[0].toUpperCase() + view.slice(1)]),
);
