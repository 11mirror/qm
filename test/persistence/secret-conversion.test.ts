import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { secretConversionMigration } from "../../src/credentials/secret-conversion.ts";
import { deriveConnectorKey, decryptSecret } from "../../src/connectors/connector-client-store.ts";
import { applyPgMigrations, pgMigrationFrom } from "../../src/persistence/pg-migrations.ts";
import { KEYCHAIN_CREDENTIALS_MIGRATION } from "../../src/credentials/keychain-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

function v1(plain: string, material: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(material).digest(), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

test("main secret-box rows and target/username credentials convert transactionally once", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  const material = "connector secret";
  const key = deriveConnectorKey(material, "keychain");
  const migration = pgMigrationFrom(secretConversionMigration({ connector: material, signing: "signing secret" }));
  try {
    await applyPgMigrations(pool, []);
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = ANY($1)", [
      [migration.id, KEYCHAIN_CREDENTIALS_MIGRATION.id],
    ]);
    await pool.query(
      "DROP TABLE keychain_credentials CASCADE; CREATE TABLE keychain_credentials (id text PRIMARY KEY, json jsonb NOT NULL)",
    );
    for (const [id, kind, extra, plain, m] of [
      ["file", "file", { target: ".config/tool/auth" }, "saved login", material],
      ["env", "env", { username: "alice", envKey: "SITE_PASSWORD" }, "password", "signing secret"],
      [
        "oauth",
        "oauth",
        { refresh: { refreshTokenEnc: v1("refresh", material), idTokenEnc: v1("id", material) } },
        "access",
        material,
      ],
    ] as const) {
      await pool.query("INSERT INTO keychain_credentials VALUES ($1,$2)", [
        id,
        {
          id,
          ownerId: "u",
          service: "site",
          kind,
          secretEnc: v1(plain, m),
          fingerprint: "f",
          createdAt: 1,
          updatedAt: 1,
          ...extra,
        },
      ]);
    }
    await applyPgMigrations(pool, [pgMigrationFrom(KEYCHAIN_CREDENTIALS_MIGRATION)]);
    for (const table of [
      "connector_clients",
      "model_credentials",
      "custom_model_providers",
      "browser_sessions",
      "slack_installation",
    ])
      await pool.query(`DROP TABLE ${table} CASCADE`);
    await pool.query("CREATE TABLE connector_clients (id text PRIMARY KEY, secret_enc text)");
    await pool.query("INSERT INTO connector_clients VALUES ('client',$1)", [v1("client secret", material)]);
    assert.equal(await applyPgMigrations(pool, [migration]), 1);
    const rows = (await pool.query("SELECT * FROM keychain_credentials ORDER BY id")).rows;
    assert.deepEqual(JSON.parse(decryptSecret(rows[0].secret_enc, key)), {
      SITE_PASSWORD: "password",
      SITE_USERNAME: "alice",
    });
    assert.equal(rows[0].username, null);
    assert.equal(rows[0].env_key, null);
    assert.deepEqual(rows[0].fields, [
      { envKey: "SITE_PASSWORD", secret: true },
      { envKey: "SITE_USERNAME", secret: false },
    ]);
    assert.deepEqual(JSON.parse(decryptSecret(rows[1].secret_enc, key)), [
      { path: ".config/tool/auth", contentBase64: Buffer.from("saved login").toString("base64") },
    ]);
    assert.equal(rows[1].target, null);
    assert.equal(decryptSecret(rows[2].refresh.refreshTokenEnc, key), "refresh");
    assert.equal(decryptSecret(rows[2].refresh.idTokenEnc, key), "id");
    assert.equal(
      decryptSecret(
        (await pool.query("SELECT secret_enc FROM connector_clients")).rows[0].secret_enc,
        deriveConnectorKey(material, "connector-clients"),
      ),
      "client secret",
    );
    assert.equal(await applyPgMigrations(pool, [migration]), 0);
    assert.throws(() => decryptSecret(v1("value", material), key), /malformed/);
  } finally {
    await pool.end();
  }
});

test("failed secret conversion rolls back converted rows and does not record success", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  const input = { connector: "key" };
  const migration = pgMigrationFrom(secretConversionMigration(input));
  try {
    await applyPgMigrations(pool, []);
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = ANY($1)", [
      [migration.id, KEYCHAIN_CREDENTIALS_MIGRATION.id],
    ]);
    for (const table of [
      "keychain_credentials",
      "connector_clients",
      "model_credentials",
      "custom_model_providers",
      "browser_sessions",
      "slack_installation",
    ])
      await pool.query(`DROP TABLE ${table} CASCADE`);
    await pool.query("CREATE TABLE connector_clients (id text PRIMARY KEY, secret_enc text)");
    const enc = v1("good", input.connector);
    await pool.query("INSERT INTO connector_clients VALUES ('good',$1),('bad','corrupt')", [enc]);
    await assert.rejects(applyPgMigrations(pool, [migration]), /malformed/);
    assert.equal(
      (await pool.query("SELECT secret_enc FROM connector_clients WHERE id='good'")).rows[0].secret_enc,
      enc,
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM qm_schema_migrations WHERE id=$1", [migration.id])).rows[0].count,
      "0",
    );
    await pool.query("DELETE FROM connector_clients WHERE id='bad'");
    assert.equal(await applyPgMigrations(pool, [migration]), 1);
  } finally {
    await pool.end();
  }
});
