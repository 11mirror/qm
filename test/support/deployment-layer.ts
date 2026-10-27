import { type DeploymentLayerBundle } from "../../src/deployment/deployment-layer-store.ts";

export const tool = (advertise: string): DeploymentLayerBundle["tools"][number] => ({
  path: "tools/acme/tool.json",
  content: JSON.stringify({
    id: "acme",
    advertise,
    hints: ["Use acme for company data."],
    auth: {
      check: "acme auth status",
      reauth: "acme auth login",
      credentialPaths: [{ path: ".config/acme", kind: "directory" }],
    },
    approvals: [{ command: "deploy", decision: "deny" }],
  }),
});

export const skill: DeploymentLayerBundle["skills"] = [
  {
    path: "skills/acme/SKILL.md",
    content: "---\nname: acme\ndescription: Use Acme systems.\n---\nRun the acme tool.\n",
  },
];
