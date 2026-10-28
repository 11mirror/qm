import { DROP_CHANNEL_POLICY_ORDERS } from "../persistence/contract-migrations.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { tenant } from "../tenant.ts";

export const BOT_MODES = ["ignore", "rollup", "action", "user"] as const;
export const DEFAULT_ROLLUP_HOURS = 24;
export type BotPolicy = { mode: (typeof BOT_MODES)[number]; rollupHours?: number };

export function parseBotLedger(input: unknown): { bots: Record<string, BotPolicy> } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { error: "bots must be an object keyed by bot author name" };
  const entries = Object.entries(input as Record<string, unknown>);
  const bots: Record<string, BotPolicy> = Object.create(null);
  const seen = new Set<string>();
  for (const [name, v] of entries) {
    const key = name.trim();
    if (!key) return { error: "bot name must be non-empty" };
    if (seen.has(key.toLowerCase())) return { error: `duplicate bot "${key}" — names match case-insensitively` };
    seen.add(key.toLowerCase());
    const pv = (v ?? {}) as { mode?: unknown; rollupHours?: unknown };
    if (!BOT_MODES.includes(pv.mode as (typeof BOT_MODES)[number])) {
      return { error: `bot "${key}": mode must be one of ${BOT_MODES.join(" | ")}` };
    }
    if (
      pv.rollupHours !== undefined &&
      (typeof pv.rollupHours !== "number" || !Number.isFinite(pv.rollupHours) || pv.rollupHours <= 0)
    ) {
      return { error: `bot "${key}": rollupHours must be a positive number` };
    }
    bots[key] = {
      mode: pv.mode as BotPolicy["mode"],
      ...(pv.mode === "rollup" && pv.rollupHours !== undefined ? { rollupHours: pv.rollupHours as number } : {}),
    };
  }
  return { bots: { ...bots } };
}

export interface ChannelPolicy {
  container: string;
  bots: Record<string, BotPolicy>;
  ambientEnabled?: boolean;
  setBy?: string;
  updatedAt: number;
}

interface ChannelPolicyRevision {
  container: string;
  bots?: Record<string, BotPolicy>;
  ambientEnabled?: boolean;
  setBy?: string;
  sessionId?: string;
  createdAt: number;
}

export interface ChannelPolicyStore {
  get(container: string): Promise<ChannelPolicy | null>;
  set(
    container: string,
    opts: {
      setBy?: string;
      bots?: Record<string, BotPolicy>;
      sessionId?: string;
      ambientEnabled?: boolean | null;
    },
  ): Promise<ChannelPolicy>;
  history(container: string, limit?: number): Promise<ChannelPolicyRevision[]>;
  list(): Promise<ChannelPolicy[]>;
  close(): Promise<void>;
}

const HISTORY_DEFAULT_LIMIT = 50;

export function createPostgresChannelPolicyStore(connectionString: string): ChannelPolicyStore {
  const { q, close } = createPgPool(connectionString, [DROP_CHANNEL_POLICY_ORDERS]);
  const row = (r: Record<string, unknown>): ChannelPolicy => ({
    container: r.container as string,
    bots: (r.bots as Record<string, BotPolicy>) ?? {},
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    updatedAt: Number(r.updated_at),
  });
  const revision = (r: Record<string, unknown>): ChannelPolicyRevision => ({
    container: r.container as string,
    ...(r.bots != null ? { bots: r.bots as Record<string, BotPolicy> } : {}),
    ...(r.ambient_enabled != null ? { ambientEnabled: r.ambient_enabled as boolean } : {}),
    ...(r.set_by != null ? { setBy: r.set_by as string } : {}),
    ...(r.session_id != null ? { sessionId: r.session_id as string } : {}),
    createdAt: Number(r.created_at),
  });
  return {
    async get(container) {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 AND container = $2", [
        tenant().orgId,
        container,
      ]);
      return rows[0] ? row(rows[0]) : null;
    },
    async set(container, opts) {
      const now = Date.now();
      const rows = await q(
        `WITH up AS (
           INSERT INTO channel_policy(org_id, container, bots, ambient_enabled, set_by, updated_at)
           VALUES ($1,$2,COALESCE($3::jsonb,'{}'::jsonb),CASE WHEN $8 THEN $7::boolean END,$4,$5)
           ON CONFLICT (${tenantCols("org_id, container")}) DO UPDATE SET
             bots = COALESCE($3::jsonb, channel_policy.bots),
             ambient_enabled = CASE WHEN $8 THEN $7::boolean ELSE channel_policy.ambient_enabled END,
             set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at
           RETURNING *
         ), hist AS (
           INSERT INTO channel_policy_history(org_id, container, bots, ambient_enabled, set_by, session_id, created_at)
           SELECT $1, $2, up.bots, up.ambient_enabled, $4, $6, $5 FROM up
         )
         SELECT * FROM up`,
        [
          tenant().orgId,
          container,
          opts.bots ? JSON.stringify(opts.bots) : null,
          opts.setBy ?? null,
          now,
          opts.sessionId ?? null,
          opts.ambientEnabled ?? null,
          opts.ambientEnabled !== undefined,
        ],
      );
      return row(rows[0]!);
    },
    async history(container, limit = HISTORY_DEFAULT_LIMIT) {
      const rows = await q(
        "SELECT * FROM channel_policy_history WHERE org_id = $1 AND container = $2 ORDER BY id DESC LIMIT $3",
        [tenant().orgId, container, limit],
      );
      return rows.map(revision);
    },
    async list() {
      const rows = await q("SELECT * FROM channel_policy WHERE org_id = $1 ORDER BY updated_at DESC", [tenant().orgId]);
      return rows.map(row);
    },
    close,
  };
}
