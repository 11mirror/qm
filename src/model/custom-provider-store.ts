import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface CustomProviderStore {
  enabled(): Promise<CustomProviderSpec[]>;
  statuses(): Promise<CustomProviderStatus[]>;
  resolveKey(id: string): Promise<string | null>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

const CUSTOM_PROVIDERS: TableSpec = {
  table: "custom_model_providers",
  key: "id",
  keyIsField: true,
  columns: cols(`name text!, protocol text!, baseUrl text!, models jsonb!, apiKeyEnc text, disabled boolean,
    updatedAt bigint!, updatedBy text!`),
};

export const CUSTOM_PROVIDERS_MIGRATION = mapToTableMigration("model/custom-providers/0001-typed", CUSTOM_PROVIDERS);

const codec = tableCodec<StoredCustomProvider>(CUSTOM_PROVIDERS);

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models,
  };
}

export function createCustomProviderStore(input: {
  databaseUrl: string;
  keyMaterial: string | Buffer;
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
}): CustomProviderStore {
  const write = input.write ?? (<T>(fn: () => Promise<T>) => fn());
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");
  const { q } = createPgPool(input.databaseUrl, [CUSTOM_PROVIDERS_MIGRATION]);
  const select = async (where: string, params: unknown[] = []) =>
    codec.rows(await q(`SELECT ${codec.columns} FROM custom_model_providers ${where} ORDER BY id`, params));
  const save = async (rec: StoredCustomProvider) => {
    await q(
      `INSERT INTO custom_model_providers (${codec.columns}) VALUES (${codec.placeholders})
       ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
      codec.values(rec.id, rec),
    );
  };

  return {
    async enabled() {
      return (await select(`WHERE disabled IS NOT TRUE`)).map(strip);
    },

    async statuses() {
      return (await select(``))
        .map((p) => ({
          ...strip(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async resolveKey(id) {
      const [saved] = await select(`WHERE id = $1`, [id]);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async upsert(spec, apiKey, updatedBy) {
      return write(async () => {
        validateCustomProviderSpec(spec);
        const actor = updatedBy.trim();
        if (!actor) throw new Error("updatedBy is required");
        const [existing] = await select(`WHERE id = $1`, [spec.id]);
        const trimmedKey = apiKey?.trim();
        const apiKeyEnc = trimmedKey ? encryptSecret(trimmedKey, key) : existing?.apiKeyEnc;
        await save({
          ...spec,
          ...(apiKeyEnc ? { apiKeyEnc } : {}),
          disabled: false,
          updatedAt: Date.now(),
          updatedBy: actor,
        });
      });
    },

    async delete(id, updatedBy) {
      return write(async () => {
        const rows = await q(
          `UPDATE custom_model_providers SET disabled = true, updated_at = $2, updated_by = $3
           WHERE id = $1 AND disabled IS NOT TRUE RETURNING id`,
          [id, Date.now(), updatedBy],
        );
        return rows.length > 0;
      });
    },
  };
}
