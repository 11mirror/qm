export const ADMIN_SECTIONS = [
  {
    label: "Organization",
    views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users", "spend"],
  },
  { label: "Logs", views: ["history", "slack", "judgments", "errors", "audit", "egress"] },
  { label: "Artifacts", views: ["files", "skills", "memory", "deployments", "crons"] },
];

export const ADMIN_VIEWS = new Set([
  ...ADMIN_SECTIONS.flatMap((section) => section.views),
  "onboarding",
  "user",
  "ackemoji",
  "keychain",
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
