import { type DeploymentLayerBundle, type StoredDeploymentLayer } from "../../src/deployment/deployment-layer-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";

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

type LayerHead = Pick<StoredDeploymentLayer, "contentHash" | "pendingAudits">;
export const readLayer = async (databaseUrl: string): Promise<LayerHead | null> =>
  ((
    await createPgPool(databaseUrl).q(
      `SELECT content_hash AS "contentHash", pending_audits AS "pendingAudits" FROM deployment_layer`,
    )
  )[0] as LayerHead | undefined) ?? null;

export async function putLayer(databaseUrl: string, r: StoredDeploymentLayer): Promise<void> {
  const { q } = createPgPool(databaseUrl);
  await q(`DELETE FROM deployment_layer`);
  await q(`INSERT INTO deployment_layer SELECT * FROM jsonb_populate_record(NULL::deployment_layer, $1)`, [
    {
      ...r,
      id: "current",
      content_hash: r.contentHash,
      updated_at: r.updatedAt,
      updated_by: r.updatedBy,
      pending_audits: r.pendingAudits,
    },
  ]);
}
