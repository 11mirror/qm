# Upgrading qm

This page lists what an operator has to change by hand when moving a deployment to a
newer qm. [Runtime upgrade compatibility](docs/upgrading-runtime.md) covers the general
procedure: pinning, migrations, qualification and rollback.

Before you start, take a database recovery point and keep the previous image and
deployment configuration available.

## Database roles and explicit tenant context

Every core deployment, including one that serves one tenant, requires two database logins. `DATABASE_URL` (and
`DATABASE_POOL_URL`, when used) must use a `NOSUPERUSER NOBYPASSRLS` application
role. `DATABASE_MIGRATION_URL` must use a separate `BYPASSRLS` migration role on
the same server and database. It is a database credential, not a bypass switch.
The migration login is used for schema initialization and migrations, not request
queries, task handlers, or maintenance sweeps. Successful startup seals migration
registration: new multitenant schemas must be registered and initialized before
startup completes. Opening an already initialized store does not check out a
migration connection. Bootstrap is serialized across processes; a migration pool has
two connections so its bootstrap lock does not consume its migration worker. Do not grant the application role
membership in the migration role, or ownership of tenant-private tables/functions.

Tenant-scoped queries use `DATABASE_URL` directly, not `DATABASE_POOL_URL`:
session tenant settings must not cross a transaction-pooling proxy. LISTEN uses
one dedicated application-role connection per database and never initializes
schemas or reads tables. Neutral metadata queries and neutral session leases use
separate pools, so a held scheduler lease does not consume their query capacity.

Before upgrading, stop all old core processes, take a database snapshot, and
provision the roles using an administrator connection. The example names below
must be adapted to the deployment's existing application role and database. Set
passwords through the deployment's secret-management tooling, not this example.

```sql
CREATE ROLE qm_migrator LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE qm_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
REVOKE qm_migrator FROM qm_app;
REASSIGN OWNED BY qm_app TO qm_migrator;
GRANT CONNECT ON DATABASE qm TO qm_app;
GRANT USAGE ON SCHEMA public TO qm_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM qm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM qm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator GRANT USAGE ON SCHEMAS TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator REVOKE ALL ON TABLES FROM qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator GRANT USAGE, SELECT ON SEQUENCES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO qm_app;
```

If the `absurd` schema already exists, also run:

```sql
GRANT USAGE ON SCHEMA absurd TO qm_app;
REVOKE ALL ON ALL TABLES IN SCHEMA absurd FROM qm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA absurd TO qm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA absurd FROM qm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA absurd TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA absurd REVOKE ALL ON TABLES FROM qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA absurd GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE qm_migrator IN SCHEMA absurd GRANT USAGE, SELECT ON SEQUENCES TO qm_app;
```

For a fresh database, make the migration role its owner and preinstall any
extensions that require an administrator. For an upgrade, verify all existing
application objects are owned by the migration role before restarting. A role
that owns a table can alter its RLS policy; `FORCE ROW LEVEL SECURITY` alone is
not sufficient to separate schema authority from application queries.

Use the migration entrypoint with the two URLs before starting the new core.
There is no home tenant. The original company's existing `qm_tenant.id` becomes
an ordinary `tenants.id`; its UUID and all existing tenant-private row IDs stay
unchanged. Existing registered tenants retain their UUIDs and configured settings.
The conversion reads the previous deployment's tenant settings once, seals secrets
with `QM_TENANT_SECRETS_KEY`, and drops `qm_tenant` in the same transaction.
Set a stable 32-byte, base64-encoded `QM_TENANT_SECRETS_KEY` before conversion and
keep it afterward. Do not replace an existing key: it decrypts registered tenants'
secrets. If a registered tenant has a trusted client but no stored provider payload,
conversion requires the previous `PORTAL_TRUSTED_OIDC` endpoint template and copies
it into that tenant's typed trusted-provider connection.

For an existing single-tenant database, keep its previous `ORG_ID`, public URLs,
Slack configuration, grants, branding, credential configuration, sign-in policy,
and storage prefix available to the migration entrypoint. Verify `ORG_ID` matches
the existing company's scope IDs. Its effective sandbox prefix, including the
old default `qm`, and its storage prefix are stored explicitly, rather than being
chosen because that company is the deployment's original tenant.

For StyleUp's existing multitenant database, snapshot it and record the singleton
UUID and every registry UUID first. Run the same conversion with StyleUp's previous
tenant configuration and existing secrets key. It registers the singleton UUID
without renumbering any company, preserves existing typed overrides, and fills
missing trusted-provider connections. Compare IDs and per-tenant row counts before
opening traffic. A routing-key conflict disables every conflicting tenant, not just
the newer row. Resolve conflicts in org IDs, hosts, identical app namespaces and sandbox prefixes before rollout. Nested app namespaces use the most specific domain, never registry age or original-tenant priority.

After successful conversion, remove tenant-specific process settings such as
`ORG_ID`, `CORE_ORG_ID`, `ADMIN_GRANTS`, public URLs, branding, Slack tokens,
trusted-client configuration and email admission policy from the deployment.
They now belong to registry rows. Retain deployment-wide infrastructure, shared
provider endpoints, cryptographic roots, database URLs and the tenant-secrets key.
`QM_MULTITENANT` is retired; there is no single-tenant runtime bypass path.
A fresh deployment creates no tenant, even if old tenant environment variables
are present. Provision an explicit registry row through `upsertTenant` or the
operator's import workflow before serving a company; health endpoints still work.

All tenants, including the original one, use UUID-derived API, capability, portal,
viewer and broker signing secrets. Deployment signing roots are not stored as
per-tenant signing settings. Existing keychain data retains a purpose-derived
AES decryption fallback, not the old API signing root. The original company's
old signed links and sessions therefore need to be renewed too. Rotate deployment
roots if they were previously known outside the infrastructure-admin boundary.

Startup replaces permissive isolation policies and adds RLS to Absurd queue tables.
Existing task ownership comes from task headers; related runs, checkpoints and
waits inherit that ownership. Events are attributed through waits and turn IDs.
Headerless tasks from the original single-tenant database receive its preserved
UUID during conversion. Orphaned queue state and ambiguous or unattributable
mixed-tenant events stop migration; repair them before retrying. Old `every:*`
scheduler tasks are cancelled. Deployment-wide periodic ticks now hold a neutral
advisory lease and dispatch ordinary scoped callbacks, with no tenant owning the
scheduler. Periodic cadence resets on process-owner replacement; durable queued
jobs and turns retain their tenant ownership.

`qm_queue_tenants(queue)` is a privileged application-callable queue
routing function. Its owner is the migration role, its search path is fixed, and
its input is restricted to the four core queues. It returns only distinct tenant
UUIDs with nonterminal work, never task payloads. `qm_tenants_with_rows(regclass[])`
likewise returns only candidate tenant UUIDs from RLS-protected public tables, not
private columns. Due predicates carry their candidate tables explicitly; exact
predicates are evaluated inside each candidate tenant's RLS context. Workers then claim, heartbeat,
run, and settle work through ordinary connections scoped to that tenant. This
also lets retired tenants' work be abandoned and suspended tenants' work wait.
Do not grant the application role `TRUNCATE` or `TRIGGER` privileges: RLS does not
protect a table-wide truncate, and application-created triggers must not execute
as the migration role. Shared maintenance now runs separately inside each active tenant, never with RLS
disabled. Host routing continues to use the non-RLS `tenants` registry.

An application query with no explicit tenant scope fails with
`Postgres query requires an explicit tenant context`. Boot, migrations, routing,
directory reads, LISTEN and health checks do not select a tenant. Dedicated neutral
application-role connections read only deployment metadata, run the approved UUID
routing functions, or LISTEN; they have no RLS exemption. Tenant notifications carry
an explicit UUID, and callbacks re-enter only that tenant's context.

### Persisted shape changes

`qm_tenant` is removed. The registry keeps its `id UUID PRIMARY KEY`, unique `slug`,
`org_id`, host array, `active | suspended` status, timestamps, existing typed fields,
and encrypted `secrets BYTEA`. It adds these nullable typed columns:

| Columns                                                         | Type                   |
| --------------------------------------------------------------- | ---------------------- |
| `api_base_url`, `public_url`, `portal_url`, `public_web_url`    | `TEXT`                 |
| `sandbox_name_prefix`, `s3_prefix`                              | `TEXT`                 |
| `apps_login_url`, `apps_login_path`                             | `TEXT`                 |
| `trusted_oidc_admin_issuer`, `email_auth_domain`                | `TEXT`                 |
| `email_auth_principals`, `api_allowed_origins`                  | `TEXT[]`               |
| `principal_rule`, `branding_default`, `external_slack_policies` | typed `JSONB` payloads |

The application login-path type remains `/auth/login | /auth/trusted/login`.
`principal_rule` declares `claim: email | sub`, optional email restrictions and
optional core admission. Branding and external Slack policy retain their existing
domain types. There is no generic settings or env bag.

The sealed secrets payload retains its original fields and adds typed `slack`,
`slackAccounts`, `brokerCredentials`, `chatSurfaces`, optional tenant-owned
`deployAppsSessionSecret`, `primaryOidc`, `trustedOidc`, and the base64 AES key
`keychainSigningFallback`. OIDC connections carry issuer, authorization/token/userinfo
and JWKS endpoints, client ID and secret, redirect URI, scopes and optional provider
parameters. These are tenant-owned provider connections, not deployment signing roots.

`background_ownership`, `instance_heartbeats` and `source_auth_replay` are deployment metadata: their
`tenant_id` columns are removed, their keys become `id`, `instance_id` and `event_id`, and they
are no longer tenant-private tables. Conflicting ownership records stop migration
instead of selecting the original tenant's value. Heartbeat rows are transient
liveness state and are cleared during the change. Background-control HTTP routes
still require both the deployment signing root and the separate deployment-control secret; no tenant gains that authority. Replay signatures are global metadata and are deduplicated conservatively while retaining their latest expiry.

`/v1/background-work` and `/v1/deployment/live-session` run without a tenant, even when reached through a company host. The live-session request changes from `{ requestId, expectedDeploymentId }` to `{ requestId, expectedDeploymentId, tenantId }`: select an active tenant UUID explicitly. The canary enters that tenant context only for its customer-level work. The smoke CLI likewise takes an explicit tenant UUID as its first argument, followed by an optional base URL. There is no default company for a deployment canary.

Invented example: an existing singleton UUID `11111111-1111-4111-8111-111111111111`
becomes the same registry UUID with `org_id=acme`, explicit hosts and a stored sandbox
prefix. Its existing private rows keep that UUID. It can subsequently be suspended
or retired exactly like any other registered tenant.

Qualification must cover ordinary requests, cross-tenant jobs and turns, tenant
retirement/suspension, and per-tenant shared sweeps. Rollback requires restoring
the pre-upgrade database snapshot and previous deployment configuration.

## Retired environment variables are ignored

qm reads a fixed set of environment variables and ignores everything else. A retired
name gives no warning or error, and it has no effect. If you set a variable below, the
setting stops applying when you upgrade. Rename it, or accept the new default.

Check every place your deployment sets environment: process env, the `env` blocks in
your deployment directory, and the secrets you push. To find retired names, use
something like this:

```sh
grep -R -n -E '\b(AGENT37|SUPERSERVE|AWS_SANDBOX|PORTER_SANDBOX|FLY)_[A-Z_]+|\b(E2B|MODAL|SPRITES|SMOLMACHINES|DO_AGENTS|LOCAL_SANDBOX)_(EGRESS_PROXY_URL|NAME_PREFIX|CPUS|MEMORY_MB|DISK_GB|[A-Z0-9_]*SNAPSHOT[A-Z0-9_]*|SANDBOX_TTL_SEC|MAX_LIFETIME_SEC|SANDBOX_TIMEOUT_SEC|REAP_IDLE_SEC|AUTOSTOP_SEC|IDLE_TIMEOUT_SEC)\b|\bSLACK_EVENTS_(MODE|PORT)\b' <your-deployment-dir>
```

### Renamed: sandbox settings are shared by every backend

Each sandbox backend used to read its own copy of these settings. They now share one
`SANDBOX_*` name. One value applies to whichever backend serves a machine. If you ran
several backends with different values, choose one. Each backend applies these settings
in its own way; [sandbox recovery](docs/sandbox-preservation.md) describes how.

| Retired                                                                                                                                                                                                       | Use instead                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `E2B_EGRESS_PROXY_URL`, `MODAL_EGRESS_PROXY_URL`, `SPRITES_EGRESS_PROXY_URL`, `SMOLMACHINES_EGRESS_PROXY_URL`, `DO_AGENTS_EGRESS_PROXY_URL`                                                                   | `SANDBOX_EGRESS_PROXY_URL`                             |
| `E2B_NAME_PREFIX`, `MODAL_NAME_PREFIX`, `SPRITES_NAME_PREFIX`, `SMOLMACHINES_NAME_PREFIX`, `DO_AGENTS_NAME_PREFIX`                                                                                            | `SANDBOX_NAME_PREFIX` (Porter app deploys read it too) |
| `MODAL_CPUS`, `SMOLMACHINES_CPUS`, `LOCAL_SANDBOX_CPUS`                                                                                                                                                       | `SANDBOX_CPUS`                                         |
| `MODAL_MEMORY_MB`, `SPRITES_MEMORY_MB`, `SMOLMACHINES_MEMORY_MB`, `LOCAL_SANDBOX_MEMORY_MB`                                                                                                                   | `SANDBOX_MEMORY_MB`                                    |
| `SMOLMACHINES_DISK_GB`                                                                                                                                                                                        | `SANDBOX_DISK_GB`                                      |
| `E2B_SNAPSHOT_INTERVAL_SEC`, `E2B_NATIVE_SNAPSHOT_INTERVAL_SEC`, `MODAL_SNAPSHOT_INTERVAL_SEC`, `MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC`, `SMOLMACHINES_SNAPSHOT_INTERVAL_SEC`, `DO_AGENTS_SNAPSHOT_INTERVAL_SEC` | `SANDBOX_SNAPSHOT_INTERVAL_SEC`                        |
| `MODAL_REAP_IDLE_SEC`, `SMOLMACHINES_AUTOSTOP_SEC`, `DO_AGENTS_IDLE_TIMEOUT_SEC`, `E2B_SANDBOX_TTL_SEC`                                                                                                       | `SANDBOX_IDLE_PARK_SEC`                                |
| `E2B_MAX_LIFETIME_SEC`, `MODAL_SANDBOX_TIMEOUT_SEC`                                                                                                                                                           | `SANDBOX_MAX_LIFETIME_SEC`                             |

When a backend is selected, `SANDBOX_EGRESS_PROXY_URL` is the only egress setting. If it
is unset, core logs a warning at startup and sandboxes have unrestricted egress.

The following sandbox settings were removed with no replacement:

- **Portable home snapshots to S3:** `*_SNAPSHOT_S3_BUCKET`. Homes are recovered with each
  provider's own pause or checkpoint. Keep durable work in git or Files.
- **Endpoint and placement overrides:** `SPRITES_BASE_URL`, `SMOLMACHINES_BASE_URL`,
  `DO_AGENTS_API_BASE_URL`, `MODAL_REGIONS`, `DO_AGENTS_SIZE_SLUG`, `SMOLMACHINES_IMAGE`,
  `E2B_PROXY` and `SPRITES_EGRESS_PROXY_ADDITIONAL_URLS`.
- **Fixed behaviour:** `MODAL_NATIVE_SNAPSHOTS_ENABLED`, `MODAL_ROTATE_AFTER_SEC` and
  `MODAL_SNAPSHOT_RETENTION_SEC`. Modal native home checkpoints are always on.
- **Scope routing:** `SANDBOX_SCOPE_BACKENDS` and `SANDBOX_SECONDARY_BACKEND`. See
  [Runtime upgrade compatibility](docs/upgrading-runtime.md#configuration-changes).
- **Deleted backends:** every `AGENT37_*`, `SUPERSERVE_*`, `PORTER_SANDBOX_*` and
  `AWS_SANDBOX_*` variable. Porter and AWS remain app deploy providers through
  `PORTER_DEPLOY_*` and `AWS_DEPLOY_*`. `SANDBOX_BACKEND` now accepts `local`, `sprites`,
  `e2b`, `modal`, `smolmachines` and `do-managed-agents`. Core refuses to start when
  `SANDBOX_BACKEND` names a deleted backend.

### Slack events transport is inferred

`SLACK_EVENTS_MODE` is gone, and so is `eventsMode` in `SLACK_ACCOUNTS` entries. The
transport now follows from the credentials:

- If `SLACK_APP_TOKEN` (`xapp-…`) is set, qm uses Socket Mode.
- If only `SLACK_SIGNING_SECRET` is set, qm uses signed HTTP events.

An HTTP-events deployment that also sets `SLACK_APP_TOKEN` switches to Socket Mode.
Unset the app token to keep HTTP. `SLACK_EVENTS_PORT` is also gone: HTTP events are
served by the core process itself.

### Other renames

| Retired                                                                                                 | Use instead                                                                            |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AGENT_API_URL` as core's own public API URL                                                            | `PUBLIC_API_URL`. Inside sandboxes, `AGENT_API_URL` is unchanged.                      |
| `DEPLOY_APPS_SESSION_SECRET`                                                                            | `PORTAL_SESSION_SECRET`                                                                |
| `AWS_DEPLOY_APPS_DOMAIN`                                                                                | `DEPLOY_APPS_DOMAIN`                                                                   |
| `AWS_REGION` / `AWS_DEFAULT_REGION` as the app-deploy region                                            | `AWS_DEPLOY_REGION` (default `us-west-2`)                                              |
| A Claude subscription token in `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` | Save it as a keychain credential and name it in `CLAUDE_AUTH_CREDENTIAL`               |
| `CODEX_AUTH_FILE`                                                                                       | Save the ChatGPT login as a keychain credential and name it in `CODEX_AUTH_CREDENTIAL` |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`                                          | A custom model provider, or `MODEL_GATEWAY_URL`                                        |

`CAPABILITY_SECRET` and `PORTAL_IDENTITY_SECRET` no longer fall back to
`CORE_SIGNING_SECRET`. When `CORE_SIGNING_SECRET` is set, all three must be set and
distinct, or core refuses to start. `QM_ROLES` is gone: every process now serves the
API, the surfaces and turns.

### Removed outright

The following settings either had a single value that every deployment used or
belonged to features that were removed. The behaviour that remains is the old
default.

- **Fly.io hosting:** `FLY_*`.
- **Fixed postures and the Claude harness:** `HARNESS`, `HARNESS_SECURITY_POSTURE`,
  `HARNESS_SHARING_POSTURE`, `SECURITY_SCREEN`, `SECURITY_SCREEN_BACKEND`,
  `SECURITY_SCREEN_CLASSIFIER`, `CLAUDE_BIN` and `CLAUDE_MODEL`.
- **Postgres is required:** `SESSION_STORE`, `RUN_STORE`, `SNAPSHOT_STORE`,
  `TRANSFER_STORE` and `SECRETS_BACKEND`.
- **Memory:** `MEMORY_STRATEGY`, `MEMORY_PROVIDER_CONFIG`, `MEMORABLE_BACKEND`,
  `MEMORY_CAPTURE`, `MEMORY_CAPTURE_*` and `MEMORY_RECALL`.
- **Switches pinned to their deployed value:** `EAGER_PROVISION`, `EXECUTE_SCRATCH`,
  `FILES_DIRECT_UPLOADS_ENABLED`, `PI_SYSTEM_CACHE_SPLIT` and `SLACK_CONTEXT_SOURCE`.
- **Slack tuning:** `SLACK_ACK_CAP_MS`, `SLACK_CHANNEL_MEMBERS_TTL_MS`,
  `SLACK_MAX_PRIVATE_CHANNELS`, `SLACK_RECENT_MESSAGES`, `SLACK_USER_CACHE_TTL_MS`,
  `SLACK_USER_SNAPSHOT_TTL_MS` and `SLACK_COPILOT_BOT_TOKEN`.
- **Swarms, skill signing and Gmail push:** `SWARMS_ENABLED`, `SWARM_DEFAULTS`,
  `SKILL_SIGNING_SECRET` and `GMAIL_PUBSUB_*`.
- **Timeouts and intervals now fixed in code:** `BACKGROUND_JOB_TTL_SEC`,
  `BACKGROUND_JOB_TTL_MAX_SEC`, `EXEC_TIMEOUT_DEFAULT_SEC`, `EXEC_TIMEOUT_MAX_SEC`,
  `TURN_WALL_CLOCK_SEC`, `TURN_LEASE_WAIT_MS`, `HEARTBEAT_INTERVAL_MS`, `LEASE_TTL_MS`,
  `MONITOR_HEARTBEAT_SEC`, `RATE_LIMIT_PER_WINDOW`, `RATE_LIMIT_WINDOW_MS`,
  `BUDGET_WINDOW_MS`, `APPROVAL_SUMMARY_TIMEOUT_MS`, `SECURITY_SCREEN_TIMEOUT_MS`,
  `SANDBOX_CAPABILITY_TTL_HOURS`, `DEEP_IDLE_MACHINE_MS`, `DEV_IDLE_MACHINE_MS`,
  `DEPLOY_IDLE_TTL_MS`, `AWS_DEPLOY_ROTATE_AFTER_SEC` and `PORTER_DEPLOY_TTL_SEC`.
- **Other settings:** `ALLOW_UNAUTHENTICATED_CORE`, `DEPLOY_GIT_DIR`,
  `EGRESS_SERVICE_HOSTS`, `PI_CAPTURE_REQUESTS`, `PLUGIN_SKILLS_DIRS`, `SEED_SKILLS`,
  `SKILLS_SEED_DIR`, `SKILL_SYNC_POLL_MS`, `SECRETS_PREFIX` and `SURFACE_DEBUG_FOOTER`.

## Signed links and sessions stop working once

Every tenant signs with UUID-scoped secrets derived from deployment roots. The
original tenant has no exception. Shared-secret or old-format tokens must be renewed;
people may need to sign in again and old signed links must be sent again.

## Tenant sandboxes use explicit tenant prefixes

The deployment still supplies shared Modal/AWS infrastructure. A tenant may carry an
explicit `sandbox_name_prefix`; otherwise names derive from the deployment prefix
and the tenant UUID. The original database conversion stores its previous effective
prefix, so existing machines can be reused without a special original-tenant branch.
Prefix collisions make all affected tenants unavailable. Other provider infrastructure
is deployment-wide; a per-tenant prefix is not permission to use another tenant's
machines.

## Tenant env bags are no longer read

A tenant's settings live in typed columns of the `tenants` table. The release that
introduced those columns copied each tenant's `env` and `secret_env` bags into them on
boot. That copy is gone. If your deployment serves several tenants and has never booted
a release with typed tenant settings, boot one first so the bags are copied, then
upgrade. A tenant that still has only env bags starts with empty settings.

## Typed tables: unknown JSON keys stop the upgrade

Many stores used to keep each record as one JSON document in a `json` column. On first
boot, a newer release converts those tables in place, one migration per table. The
migration ids end in `/0001-typed`. Each conversion goes through these steps:

1. Add one column per known field.
2. Fill the new columns from the JSON.
3. Check every row.

The conversion keeps the `json` column. A trigger keeps the old and new forms in step,
so the previous image can still run against the database and rollback stays possible.
A later release drops the `json` column.

The check fails closed. A row stops the conversion in any of these cases:

- Its JSON has a key the release does not know.
- A required field is missing.
- A value does not convert back to the same JSON.
- The document is not an object.

Rows like this usually come from a fork that added fields, a newer build that was
rolled back, or a hand edit. qm does not drop data it does not understand.

**What you see:** startup exits with a Postgres error that names the table and the
first offending row:

```
<table>: row <id> does not convert to typed columns
```

Each migration runs in its own transaction. Tables converted earlier in the same boot
stay converted. The failing table is left exactly as it was, and the migration ledger
does not record it. The previous image keeps working, so you can roll back while you
investigate.

**How to fix it:**

1. Find the table's expected fields. Search the source for the table name or its
   `…/0001-typed` migration id. The table spec next to `mapToTableMigration` lists the
   columns. Fields named in `dropKeys` are discarded on purpose.
2. See which keys the table holds:
   ```sql
   SELECT k, count(*) FROM <table>, jsonb_object_keys(json) AS k GROUP BY k ORDER BY k;
   SELECT json FROM <table> WHERE id = '<id>';
   ```
3. Copy the rows you are about to change:
   `CREATE TABLE <table>_preupgrade AS SELECT * FROM <table>;`
4. Repair the data:
   - If no code needs a stray key, remove it:
     `UPDATE <table> SET json = json - '<key>' WHERE json ? '<key>';`
   - Delete a row that is junk.
   - If the data matters, carry it in your fork's table spec, or raise an issue
     upstream, before you upgrade.
5. Restart. The conversion reruns from the start and stops at the next bad row, if
   there is one. The key query in step 2 finds every unknown key at once, so you can
   fix them all before restarting.

Do not edit `qm_schema_migrations` to skip a conversion.

## Per-tenant turn queues are no longer merged at boot

The release that moved every tenant onto one shared set of Absurd queues also moved, on
each boot, the tasks left in per-tenant queues (named like `turns_people_t1a2b3c4d5e6f`)
into the shared queues and dropped them. That boot step is gone. If your deployment has
never booted a release with shared queues, boot that release once before this one. To
check, this query must return no rows:

```sql
SELECT queue_name FROM absurd.queues WHERE queue_name ~ '_t[0-9a-f]{12}$';
```

## Upgrading from older releases

Upgrade one release line at a time, and boot each step before moving on. Startup
refuses a database that is too old for the current schema baseline and names the
migrations it lacks. Boot the intermediate release that the message points to, then
continue. [Runtime upgrade compatibility](docs/upgrading-runtime.md#database-upgrades-and-rollback)
has the current requirements.
