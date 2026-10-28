# Provider contracts: restoration checkpoint

Base: `2837f61e`. Code checkpoint: `9a6bfd295ae1539e1a45f4ab7ef922e9f10a68a3` on `regan/providers-one-contract`.

This is restoration plus targeted consolidation, not completion of the requested API-only-adapter end state. No live Fly or Superserve operation was performed.

## Measurement

Counts are physical TypeScript lines, including blanks. Native client/transport files count as provider-specific, not as shared contract code. AWS microVM API is assigned to app hosting, not sandboxes; it is actively imported by AWS app hosting. Service/store/auth/frontend files outside the listed contract files are excluded. No test lines are included.

| Area        | Provider-specific before | After | Contract before | After | Wiring before | After |
| ----------- | -----------------------: | ----: | --------------: | ----: | ------------: | ----: |
| Sandboxes   |                     3956 |  4408 |            2902 |  2935 |           211 |   242 |
| App hosting |                     2112 |  2810 |             209 |   300 |           168 |   204 |

Restoration necessarily increases the candidate, which had deleted these providers. Retained sandbox adapters alone shrink 2,235 to 2,200 lines; retained app adapters shrink 1,333 to 1,327. Restored Superserve adapter/client adds 487 lines. Restored Fly adapter/client/typed port storage adds 704 lines. These figures do not claim a net reduction across the entire change.

### File-level counts

### sandbox adapters

| File                        | Before | After |
| --------------------------- | -----: | ----: |
| `modal-sandbox.ts`          |    528 |   507 |
| `sprites-sandbox.ts`        |    498 |   494 |
| `e2b-sandbox.ts`            |    227 |   227 |
| `local-sandbox.ts`          |    358 |   358 |
| `managed-agents-sandbox.ts` |    286 |   276 |
| `smolmachines-sandbox.ts`   |    338 |   338 |
| `superserve-sandbox.ts`     |      0 |   253 |

### sandbox native clients

| File                       | Before | After |
| -------------------------- | -----: | ----: |
| `modal-client.ts`          |    333 |   333 |
| `modal-image.ts`           |     32 |    32 |
| `managed-agents-client.ts` |    701 |   701 |
| `managed-agents-grpc.ts`   |    116 |   116 |
| `managed-agents-tunnel.ts` |    132 |   132 |
| `e2b-client.ts`            |    362 |   362 |
| `docker-exec.ts`           |     45 |    45 |
| `superserve-client.ts`     |      0 |   234 |

### sandbox contract

| File                        | Before | After |
| --------------------------- | -----: | ----: |
| `sandbox.ts`                |    300 |   300 |
| `provider-sandbox.ts`       |    561 |   586 |
| `exec-sandbox-base.ts`      |    280 |   280 |
| `exec-file-ops.ts`          |    366 |   366 |
| `exec-process-session.ts`   |    188 |   188 |
| `layer-tool-install.ts`     |     80 |    80 |
| `connector-sdk.ts`          |     76 |    76 |
| `sandbox-env.ts`            |     60 |    60 |
| `ro-layers.ts`              |     63 |    63 |
| `process-poll.ts`           |     42 |    42 |
| `await-process-exit.ts`     |     12 |    12 |
| `exec-kill.ts`              |     33 |    33 |
| `tar.ts`                    |     43 |    43 |
| `sandbox-bodies.ts`         |     77 |    77 |
| `sandbox-routing.ts`        |    288 |   296 |
| `sandbox-resources.ts`      |    360 |   360 |
| `sandbox-resource-store.ts` |     73 |    73 |

### app adapters

| File                        | Before | After |
| --------------------------- | -----: | ----: |
| `aws-deploy-provider.ts`    |    670 |   670 |
| `porter-deploy-provider.ts` |    291 |   287 |
| `docker-deploy-provider.ts` |    160 |   160 |
| `e2b-deploy-provider.ts`    |    212 |   210 |
| `fly-deploy-provider.ts`    |      0 |   359 |

### app native clients

| File                            | Before | After |
| ------------------------------- | -----: | ----: |
| `aws-deploy-data.ts`            |    169 |   169 |
| `porter-client.ts`              |    241 |   241 |
| `fly-client.ts`                 |      0 |   313 |
| `fly-deploy-ports.ts`           |      0 |    32 |
| `../sandbox/aws-microvm-api.ts` |    369 |   369 |

### app contract

| File                        | Before | After |
| --------------------------- | -----: | ----: |
| `deploy-provider.ts`        |     18 |    18 |
| `shared-deploy-provider.ts` |    191 |   211 |
| `machine-rollout.ts`        |      0 |    54 |
| `endpoint-transport.ts`     |      0 |    17 |

### wiring

| File         | Before | After |
| ------------ | -----: | ----: |
| `sandbox.ts` |    211 |   242 |
| `deploy.ts`  |    168 |   204 |

## Actual contracts

### Sandbox

`SandboxDriver` supplies backend/home/OS/tool/resource descriptors, writable persistence, egress capability, exec, absolute byte reads/writes, inspect, create, resume, destroy and live-cache lookup. Optional native operations are park, forget, restart, rotationDue, ensureEgress and checkpoints (capture/restore/drop, machineBound and now retentionMs). `MachineState` now optionally reports expiresAtMs.

`createProviderSandbox` owns scope-to-name mapping, scratch/resident provisioning, initialization state, serialized lifecycle locks, checkpoint capture/throttle/error bookkeeping, restore failure handling, files/archive/blob transfer, environment assembly, credential-path cleanup and staging, layer/connector installation, portable process sessions, teardown and destruction. Names use `sandboxScopeName(sandboxNamePrefix(shared), scope)`; prefixes come from the tenant view, not per-tenant environment bags. Persistent sandbox records are tenant-scoped typed columns. Resource ownership/routing remains in sandbox resources/router, with no fallback to a substitute provider.

The shared contract now interprets checkpoint expiry instead of Modal/Sprites wrapping status independently. Modal declares 30-day retention; Sprites declares no time expiry (`null`) and machine-bound identity. Other providers do not claim an expiry they have not established. Expired checkpoints fail before native restoration, rather than starting an empty home.

Provider egress primitives still differ: Modal/E2B/managed-agent creation network settings, Sprites policy API, local Docker networking and Smol allow lists. The driver enforces provider networking; the shared layer injects the authenticated proxy environment and checks declared capability. Generic resources are CPU/memory/disk; provider-specific admissible shapes remain native.

### App hosting

`DeployProvider` exposes `profile`, `apply(deployment, version, gitBundle?)`, `resolveEndpoint`, `destroy` and `logs`. The profile declares managed scale-to-zero, optional Git-bundle application, data directory and bundle size limit. Deployment/version identity, ACLs, versions, credentials, lifecycle locks, bundle materialization and visibility live in the deploy service/store, not a provider-specific API.

Shared app helpers own environment validation/exports, supervised launch, TCP/HTTP readiness and diagnostics, liveness/log checks, bundle enumeration/extraction and launch/readiness composition. New machine-rollout helpers own health-gated replacement, routing rollback, cleanup and in-place durable-volume updates. Generic endpoint transport now supports SOCKS for a private endpoint without a Fly branch in the proxy handler. This is ordinary HTTP/HTTPS transport through a deployment-provisioned SOCKS listener, not WireGuard provisioning.

Fly retains exact `${appPrefix}-${deployment.id}` or explicit shared-app identity, isolated application network and org checks, Flycast ingress, volume identity (`qm_data` standalone, hashed per-deployment shared), mount validation, service configuration and Fly API interactions. It does not rename or move domains. Existing tenant apps domains continue through tenant settings and the generic app gateway.

## Adapter contents now

| Adapter                | Native responsibilities remaining                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modal sandbox          | SDK calls, name claims, snapshot/restore primitives; lifetime rotation, renewal, activity/idle/orphan policy still present. These remaining policies have NOT all been moved into the shared contract.   |
| Sprites sandbox        | Sprites API calls, native checkpoints, network policy, byte-exact output/pressure handling, Tasks keepalive. No custom checkpoint-status wrapper.                                                        |
| E2B sandbox            | SDK session adoption/revival, metrics, native snapshot restore and timeout/keepalive.                                                                                                                    |
| Local sandbox          | Docker network/volume/agent discovery, image fingerprint, daemon calls.                                                                                                                                  |
| Managed-agents sandbox | SDK/gRPC session tunnel operations, checkpoint/rollback and native process transport. Redundant scope map/status wrappers removed.                                                                       |
| Smol sandbox           | Machine/exec/file/network API, native readiness and detached-exec handling.                                                                                                                              |
| Superserve sandbox     | SDK session/adoption/create/pause/restart/delete and network verification; finite disk retention, bounded command streams. Uses the shared provision/files/process/credential/checkpoint-free lifecycle. |
| AWS apps               | MicroVM API, renewal/rotation, native token/data snapshot/Litestream policies. Not rewritten as an API-only adapter.                                                                                     |
| Porter apps            | Native bodies/volumes/ingress, upload/extraction; shared launch and readiness.                                                                                                                           |
| E2B apps               | SDK session persistence/keepalive/cleanup and archive upload; shared launch and readiness.                                                                                                               |
| Docker apps            | Docker container/network/port operations; existing shared boot/readiness.                                                                                                                                |
| Fly apps               | Fly API/configuration/ownership/ingress/volume identity; shared machine replacement and durable in-place update; shared boot/readiness/diagnostics/transport.                                            |

## Configuration and storage shapes

Only three optional tenant columns are added: `deploy_provider` (aws/docker/porter/e2b/fly), `fly_app_prefix`, `fly_shared_app_name`. For an imported tenant using Fly, one explicit Fly identity is required; it never silently inherits the home's app prefix/shared app. Home deployments retain their deployment-config identity. A tenant's explicit provider takes precedence over the deployment default.

All other restored values are deployment configuration: Fly token/org/region/base image/volume size/SOCKS listener, and Superserve API key/template/base URL. No new per-tenant secret fields, number columns, environment bags, sandbox-prefix override or feature flags are added. Existing defaults: Fly region lhr, CPU shared/1/512 MiB, port 8080; Superserve resident idle pause 15 minutes, keep-warm at least 1 hour, disk retention 30 days; scratch idle pause 10 minutes and retention 1 day.

Environment inputs restored: `SUPERSERVE_API_KEY`, `SUPERSERVE_TEMPLATE`, `SUPERSERVE_BASE_URL`, `FLY_DEPLOY_API_TOKEN`, `FLY_DEPLOY_APP_PREFIX`, `FLY_DEPLOY_BASE_IMAGE`, `FLY_ORG`, `FLY_DEPLOY_REGION`, `FLY_DEPLOY_SHARED_APP_NAME`, `FLY_DEPLOY_DATA_VOLUME_SIZE_GB`; `FLY_DEPLOY_SOCKS_PROXY_PORT` supplies an already-provisioned local private transport. `DEPLOY_PROVIDER` accepts fly; `SANDBOX_BACKEND` accepts superserve. Core secret validation covers the restored API keys.

Before: tenant settings had none of the three Fly/provider fields. After (invented example): `{deployProvider:"fly",flyAppPrefix:"qm-acme"}` plus the existing tenant fields; app naming remains `qm-acme-<deployment UUID>`. A shared-app example is `{deployProvider:"fly",flySharedAppName:"company-app"}`. Existing appsDomain is unchanged. Superserve uses deployment settings and adds no tenant fields.

Fly port ownership before (invented example): table `fly_deploy_ports`, map row `{id:"company-app:25000",json:"deployment-a"}`. After: typed `slot="company-app:25000", deployment_id="deployment-a"`, tenant-keyed uniqueness and RLS through the existing typed-table/tenancy framework. A one-time scalar-to-object conversion runs before the standard typed-table conversion; conflict ownership survives restarts. The old JSON/id columns are contracted away by that framework. No new id-plus-JSON table helper is introduced.

Superserve restoration retains `superserve_sandbox_bodies` with scope key and typed initialization/checkpoint state plus optional sandboxId. Contract migration 0010 no longer drops that table; its prior checksum is accepted. A deployment that already executed the drop can rebuild initialization metadata by native lookup, but this cannot recover deleted database records. Native provider files are not deleted by this migration. `superserve_config_epochs` remains retired; no config-epoch compatibility store is restored.

DeployEndpoint gains optional `socksProxyPort:number`; existing host/port/tls/headers remain unchanged. Driver checkpoint metadata gains optional `retentionMs:number|null`; MachineState gains optional `expiresAtMs:number`. These are runtime contract fields, not new persisted JSON blobs.

## Fleet field evidence and unresolved decisions

The supplied task summary establishes 154 Fly-hosted companies and 99 AWS-hosted companies, so hosting provider selection genuinely differs by tenant. Fly app identity must be retained during import. However, the detailed inventory Files record was not readable in this subagent's scope (file lookup returned 404). Per-field cardinality for org/region/image/token/SOCKS/volume/template/base URL was requested from the coordinator and was not available while this checkpoint was written. Deployment-vs-tenant placement beyond provider choice/identity is therefore provisional, not an asserted inventory finding.

The coordinator specifically held a sandbox-prefix override pending Regan's decision. None is included. Consequently adopting the already-existing Superserve machine under a new derived tenant prefix is NOT demonstrated and is a migration blocker to resolve, not a claimed completed feature.

## Tests and checks

Targeted files only; PostgreSQL runs used one worker on the 1-vCPU Modal sandbox.

- Fly provider HTTP-boundary regression tests: 32 passed.
- Superserve SDK HTTP-boundary tests: 12 passed.
- Superserve sandbox shared-lifecycle tests with SDK HTTP boundary faked: 4 passed.
- Generic SOCKS/direct endpoint transport tests with TCP/HTTP protocol boundary: 2 passed.
- Provider persistence migration tests: 2 passed.
- Shared sandbox contract tests: 2 passed.
- Modal sandbox: 48 passed; Sprites sandbox: 58 passed; managed-agents sandbox: 36 passed.
- E2B sandbox: 48 passed; local sandbox: 25 passed; Smol sandbox: 32 passed.
- AWS hosting: 31 passed plus 25 app-data tests.
- Porter hosting: 26 passed; E2B hosting: 5 passed; Docker hosting: 10 passed.
- Full TypeScript check passed. ESLint and formatting passed on changed TypeScript files. Code ratchets: zero problems against 2837f61e. git diff --check passed.

Existing-provider suites retain their existing fake boundaries; this checkpoint does NOT claim all of those existing fakes have been rewritten to the HTTP boundary. The newly restored providers are covered at that boundary. No live cloud QA or independent adversarial review was performed. No merge/deployment is requested on mock results alone.

## Person/model-visible text changes

- Superserve disappeared from backend routing/configuration -> Superserve is selectable/listed again with its existing OS/tool/persistence profile and restored configuration errors.
- Fly was rejected as an unknown deploy provider -> Fly is accepted; the invalid-provider message now lists fly.
- Superserve template mismatch previously destroyed the machine and emitted `sandbox <id> was built from template <old>, not <new>; it was destroyed and the next provision creates a replacement` -> refuses with `superserve sandbox <id> uses another template; reconcile it before provisioning`, preserving files.
- Superserve failed network reconciliation previously destroyed the machine and reported `could not take the configured egress policy` -> refuses `superserve sandbox <id> could not take the configured egress policy`, without deletion.
- `Modal home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement` -> `modal home checkpoint has expired; explicitly import a recovery snapshot before creating a replacement` (shared backend naming); the same generic policy now applies to any driver declaring retention.
- E2B `e2b deploy: app start failed (exit <code>...); stderr: ...; stdout: ...` and Porter `porter deploy app start failed ...` -> shared, secret-masked `app <name/id> (deployment <id>): app launch failed (exit <code>...); stderr: ...; stdout: ...`, and an app_start_failed diagnostic is recorded.
- Imported Fly identity missing -> new refusal `Fly tenant requires its own app prefix or shared app name` instead of borrowing home identity.

## Deferred sandbox adapter costs

These are engineering estimates from the removed code and surviving clients, not promises of verified provider availability. All would need typed records/config, routing/secret schema, HTTP-boundary tests and live-provider QA.

- Agent37: medium/high, roughly 1-2 engineer-days plus live QA. Removed adapter was 400 lines. HTTP machine creation/adoption, refusal classification, long exec polling, chunked file transport and resource conversion must be retained; it reported no egress enforcement. No native checkpoint recovery was supplied. Reuse the shared sandbox lifecycle instead of restoring its old map store.
- Porter sandbox: low/medium, roughly half to one engineer-day plus live QA. Removed adapter was 183 lines; Porter client/exec/volume helpers survive in app hosting. Restore a thin machine/volume/ingress adapter and typed initialization state; preserve volume identity and per-tenant name selection. Confirm current egress support instead of advertising it from old code.
- AWS microVM sandbox: medium, roughly 1-2 engineer-days plus live QA. Removed adapter was 236 lines; 369-line microVM API is still required by AWS apps and is retained. Reintroduce typed microVM ID/endpoint/creation time, idle/lifetime rotation, checkpoint recovery choice and validated ingress/egress connector configuration. The 34 AWS-settings configurations are not evidence of actual sandbox usage.

## Portable home proposal (not implemented)

A portable home is a distinct recovery guarantee, not a generic name for native checkpoints. Put its policy in the sandbox contract and native checkpoint mechanics in the driver. The contract already exports a credential-filtered home archive and has blob staging; reuse those primitives.

Small proposed shape: an optional shared portable-home store keyed by tenant/resource/home generation, with typed latest generation, blob reference, checksum, byte count and captured-at columns; immutable S3 archive objects live under the tenant namespace. Capture only after stripping resident/ephemeral credential paths and excluding sockets/process state. Commit a new durable pointer only after the upload/checksum succeeds; keep the previous pointer until that commit. Restore before marking initialization complete; missing/corrupt archives fail closed rather than producing an empty home. Explicit cross-provider moves consume a portable home, never a native machine-bound checkpoint.

Report native recovery and portable recovery separately, including age and failure. Native fast recovery remains first choice on the same provider. Modal's 30-day expiry must be renewable or backed by portable storage; Sprites checkpoints remain tied to their machine; Smol's resident disk is not a checkpoint. Portable capture cadence, maximum archive size, databases/background-process consistency and who can explicitly discard a home require a product decision before implementation. No home exporter/S3 replication job is added here.

## Assembly risks and unfinished scope

1. Step 4 is partial: API-only adapters are NOT achieved. Shared checkpoint expiry/status and app launch/rollout are consolidated, but native idle/rotation/adoption policy remains in existing adapters. Do not describe this checkpoint as the completed LOC reduction project.
2. Private Fly endpoints on AWS need a working deployment-provisioned SOCKS listener/WireGuard/VPC route. This checkpoint restores HTTP transport through that listener, not the removed automatic ECS/WireGuard peer manager. No reachable listener was verified.
3. Import must populate Fly tenant provider/identity and preserve deployment IDs, port assignments and appsDomain. Inventory cardinality still needs confirmation before deciding any additional tenant fields.
4. Superserve's old machine-name adoption is unresolved without the held prefix decision. Do not cut the Superserve company over based on these tests.
5. Native Fly update rollback uses the previous machine configuration read before the update. Unlike the historical removed code, this checkpoint does not restore a durable accepted-config store; an interrupted update followed by a core restart may leave an unaccepted configuration as the next rollback baseline. Resolve if fleet volume-bearing apps require crash-stable accepted-config rollback.
6. Provider factories are tenant-local; conflicts are likely with the fail-closed branch in src/wiring/sandbox.ts, src/wiring/deploy.ts, tenant-settings.ts and tenancy.ts. Preserve both branches' fail-closed behavior. The sandbox factory proxy has no provider fallback.
7. Carry the removal of the Superserve table DROP in contract/0010 when assembling; restoring the adapter while keeping that DROP would destroy its initialization state.
8. Real Fly/Superserve credentials and explicit canary resources are needed for prod-like QA. Live app volumes/identities/domains and egress cannot be certified from these mocks.
