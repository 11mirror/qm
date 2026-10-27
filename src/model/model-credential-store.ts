import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { MODEL_PROVIDERS, type ModelProvider, type ModelProviderAvailability } from "./pi-models.ts";

export { isModelProvider, type ModelProvider } from "./pi-models.ts";

interface StoredModelCredential {
  provider: ModelProvider;
  secretEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface ModelCredentialStatus {
  provider: ModelProvider;
  configured: boolean;
  source: "admin" | "environment" | "absent";
  updatedAt?: number;
  updatedBy?: string;
}

export interface ModelCredentialStore {
  resolve(provider: ModelProvider): Promise<string | null>;
  set(provider: ModelProvider, apiKey: string, updatedBy: string): Promise<void>;
  delete(provider: ModelProvider, updatedBy: string): Promise<void>;
  statuses(): Promise<ModelCredentialStatus[]>;
  availability(): Promise<ModelProviderAvailability>;
}

const MODEL_CREDENTIALS: TableSpec = {
  table: "model_credentials",
  key: "provider",
  keyIsField: true,
  columns: cols(`secretEnc text, disabled boolean, updatedAt bigint!, updatedBy text!`),
};

export const MODEL_CREDENTIALS_MIGRATION = mapToTableMigration("model/credentials/0001-typed", MODEL_CREDENTIALS);

const codec = tableCodec<StoredModelCredential>(MODEL_CREDENTIALS);

export function createModelCredentialStore(input: {
  databaseUrl: string;
  keyMaterial: string | Buffer;
  fallback?: Partial<Record<ModelProvider, string>>;
}): ModelCredentialStore {
  const key = deriveConnectorKey(input.keyMaterial, "model-credentials");
  const { q } = createPgPool(input.databaseUrl, [MODEL_CREDENTIALS_MIGRATION]);

  async function records(providers: readonly ModelProvider[]): Promise<Map<string, StoredModelCredential>> {
    const rows = codec.rows(
      await q(`SELECT ${codec.columns} FROM model_credentials WHERE provider = ANY($1::text[])`, [providers]),
    );
    return new Map(rows.map((row) => [row.provider, row]));
  }

  async function save(rec: StoredModelCredential): Promise<void> {
    await q(
      `INSERT INTO model_credentials (${codec.columns}) VALUES (${codec.placeholders})
       ON CONFLICT (${tenantCols("provider")}) DO UPDATE SET ${codec.updates}`,
      codec.values(rec.provider, rec),
    );
  }

  return {
    async resolve(provider) {
      const saved = (await records([provider])).get(provider);
      if (saved?.disabled) return null;
      return saved?.secretEnc ? decryptSecret(saved.secretEnc, key) : input.fallback?.[provider]?.trim() || null;
    },

    async set(provider, apiKey, updatedBy) {
      const secret = apiKey.trim();
      if (!secret) throw new Error("API key is required");
      const actor = updatedBy.trim();
      if (!actor) throw new Error("updatedBy is required");
      await save({
        provider,
        secretEnc: encryptSecret(secret, key),
        disabled: false,
        updatedAt: Date.now(),
        updatedBy: actor,
      });
    },

    async delete(provider, updatedBy) {
      await save({
        provider,
        disabled: true,
        updatedAt: Date.now(),
        updatedBy,
      });
    },

    async statuses() {
      const saved = await records(MODEL_PROVIDERS);
      return MODEL_PROVIDERS.map((provider): ModelCredentialStatus => {
        const rec = saved.get(provider);
        if (rec)
          return {
            provider,
            configured: !rec.disabled,
            source: "admin",
            updatedAt: rec.updatedAt,
            updatedBy: rec.updatedBy,
          };
        return input.fallback?.[provider]?.trim()
          ? { provider, configured: true, source: "environment" }
          : { provider, configured: false, source: "absent" };
      });
    },

    async availability() {
      const statuses = await this.statuses();
      return {
        anthropic: statuses.find((status) => status.provider === "anthropic")!.configured,
        openai: statuses.find((status) => status.provider === "openai")!.configured,
        openrouter: statuses.find((status) => status.provider === "openrouter")!.configured,
      };
    },
  };
}
