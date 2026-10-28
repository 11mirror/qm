import { createHash, createDecipheriv } from "node:crypto";
import type { PoolClient } from "pg";
import { deriveConnectorKey, encryptSecret, decryptSecret } from "../connectors/connector-client-store.ts";
import type { PgMigrationDefinition } from "../persistence/pg-migrations.ts";
import { fingerprintOf } from "./keychain.ts";
import { homeRelativePath } from "./paths.ts";
import { deriveTenantSecret, tenantFromRow } from "../../plugins/chassis/src/tenant-settings.ts";

type Material = Buffer | string;
type Keys = { connector: Material; signing?: Material };
type Row = Record<string, unknown>;

function openV1(enc: string, materials: readonly Material[]): string {
  const [iv, tag, body, extra] = enc.split(":");
  if (!iv || !tag || body === undefined || extra !== undefined) throw new Error("malformed encrypted secret");
  for (const material of materials) {
    try {
      const key =
        Buffer.isBuffer(material) && material.length === 32 ? material : createHash("sha256").update(material).digest();
      const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      cipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString("utf8");
    } catch {
      continue;
    }
  }
  throw new Error("secret conversion failed authentication");
}

function box(keys: Keys, purpose: string) {
  const materials = [keys.connector, ...(purpose === "keychain" && keys.signing ? [keys.signing] : [])];
  const key = {
    ...deriveConnectorKey(keys.connector, purpose),
    fallbacks: materials.slice(1).map((material) => deriveConnectorKey(material, purpose)),
  };
  return {
    open: (enc: string) => (enc.startsWith("v2:") ? decryptSecret(enc, key) : openV1(enc, materials)),
    seal: (plain: string) => encryptSecret(plain, key),
  };
}

function credentialShape(row: Row, keys: Keys): Row {
  const { target, username, ...current } = row;
  const cipher = box(keys, "keychain");
  let plain: string | undefined;
  if (row.kind === "file" && !row.targets && typeof target === "string") {
    const path = homeRelativePath(target);
    plain = JSON.stringify([
      { path, contentBase64: Buffer.from(cipher.open(String(row.secret_enc))).toString("base64") },
    ]);
    current.targets = [path];
  } else if (row.kind === "env" && !row.fields && typeof username === "string" && username) {
    const envKey =
      typeof row.env_key === "string"
        ? row.env_key
        : `${String(row.service)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
    const base = envKey.replace(/_(PASSWORD|PASS|TOKEN|SECRET|API_KEY|KEY)$/i, "");
    const userKey = `${base || envKey}_USERNAME`;
    plain = JSON.stringify({ [envKey]: cipher.open(String(row.secret_enc)), [userKey]: username });
    current.fields = [
      { envKey, secret: true },
      { envKey: userKey, secret: false },
    ];
    current.env_key = null;
  }
  if (plain !== undefined) {
    current.secret_enc = cipher.seal(plain);
    current.fingerprint = fingerprintOf(plain);
  }
  current.target = null;
  current.username = null;
  return current;
}

const STORES = [
  ["keychain_credentials", "id", "keychain", ["secret_enc"]],
  ["connector_clients", "id", "connector-clients", ["secret_enc"]],
  ["model_credentials", "provider", "model-credentials", ["secret_enc"]],
  ["custom_model_providers", "id", "custom-model-providers", ["api_key_enc"]],
  ["browser_sessions", "principal_id", "keychain", ["state_enc"]],
  ["slack_installation", "org_id", "slack-installation", ["bot_token_enc", "app_token_enc"]],
] as const;

async function convertStore(
  client: PoolClient,
  spec: (typeof STORES)[number],
  resolve: (row: Row) => Keys,
): Promise<void> {
  const [table, keyColumn, purpose, encrypted] = spec;
  if (!(await client.query("SELECT to_regclass($1) AS present", [table])).rows[0].present) return;
  const rows = await client.query(`SELECT * FROM ${table} FOR UPDATE`);
  for (const row of rows.rows as Row[]) {
    const keys = resolve(row);
    const cipher = box(keys, purpose);
    const next = table === "keychain_credentials" ? credentialShape(row, keys) : { ...row };
    for (const field of encrypted) {
      const enc = next[field];
      if (typeof enc === "string" && !enc.startsWith("v2:")) next[field] = cipher.seal(cipher.open(enc));
    }
    if (table === "keychain_credentials" && row.refresh) {
      const refresh = { ...(row.refresh as Row) };
      for (const field of ["refreshTokenEnc", "idTokenEnc"]) {
        const enc = refresh[field];
        if (typeof enc === "string" && !enc.startsWith("v2:")) refresh[field] = cipher.seal(cipher.open(enc));
      }
      next.refresh = refresh;
    }
    const changed = Object.keys(next).filter((field) => JSON.stringify(next[field]) !== JSON.stringify(row[field]));
    if (!changed.length) continue;
    const values = changed.map((field) => {
      const value = next[field];
      return field === "fields" || (typeof value === "object" && value !== null && !Array.isArray(value))
        ? JSON.stringify(value)
        : value;
    });
    const where = row.tenant_id ? `tenant_id = $${values.length + 2} AND ` : "";
    await client.query(
      `UPDATE ${table} SET ${changed.map((field, i) => `${field} = $${i + 1}`).join(", ")}
      WHERE ${where}${keyColumn} = $${values.length + 1}`,
      [...values, row[keyColumn], ...(row.tenant_id ? [row.tenant_id] : [])],
    );
  }
}

export function secretConversionMigration(input: Keys & { tenantSecretsKey?: Buffer }): PgMigrationDefinition {
  return {
    id: "zz/credentials/0001-secret-box-and-shapes",
    statements: [],
    transform: {
      version: "secret-box-and-shapes/1",
      async run(client) {
        const keys = new Map<string, Keys>();
        if ((await client.query("SELECT to_regclass('qm_tenant') AS present")).rows[0].present) {
          for (const row of (await client.query("SELECT id FROM qm_tenant")).rows) keys.set(row.id, input);
        }
        if ((await client.query("SELECT to_regclass('tenants') AS present")).rows[0].present) {
          for (const row of (await client.query("SELECT * FROM tenants")).rows) {
            const t = tenantFromRow(row, input.tenantSecretsKey);
            keys.set(t.id, {
              connector: t.secrets.connectorSecretKey ?? input.connector,
              ...(typeof input.signing === "string" ? { signing: deriveTenantSecret(input.signing, t.id) } : {}),
            });
          }
        }
        for (const spec of STORES)
          await convertStore(client, spec, (row) => {
            if (spec[0] === "connector_clients") return input;
            const found = row.tenant_id ? keys.get(String(row.tenant_id)) : undefined;
            if (row.tenant_id && !found) throw new Error(`secret conversion: unknown tenant ${row.tenant_id}`);
            return found ?? input;
          });
      },
    },
  };
}
