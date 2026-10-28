# Capability token encoding and rollout

Room capabilities carry participant assertions for authorization. Large rosters appear
in both the publishing and keychain audiences, so uncompressed tokens can exceed HTTP
header limits before a request reaches core. Increasing core's header limit does not
fix limits imposed by upstream proxies.

Claim payloads larger than 4096 bytes are always compressed, for every capability audience.
The signed envelope contains a base64url raw-DEFLATE payload. Verification authenticates the
envelope before inflating it, limits decoded claims to 1 MiB, and applies the existing claim
checks. Small tokens keep the plain encoding, and verifiers read both. Tokens remain
self-contained across replicas and restarts; no authorization state is moved into a
process-local cache. Compression reduces roster repetition but is not a fixed-size token:
unusually large or poorly compressible claims can still exceed a deployment's header limit.

## Credential broker tokens

A command that selects shared org credentials or connected apps (`connector:<host>:<account>`,
or a granted connected-app handle) gets one `AGENT_CREDENTIAL_TOKEN` covering exactly the
brokered handles it selected. `credentials` lists org credential slugs; `connectors` lists
each connected app's handle, host, owner, account type and, for another person's grant, the
grant id. The OAuth token itself never enters the sandbox: `/v1/credentials/http/<host or
handle>/<path>` looks up the owner's current token (refreshing it when due), rechecks a named
grant, and streams the request to that host with `Authorization: Bearer` added.

## Sandbox token lifetime

Turn tokens handed to sandboxes (agent API, credential broker, egress proxy, OAuth
consent) expire 48 hours after the turn starts, which bounds how long background jobs
launched by that turn keep their access. This does not remove run/lease, background-job,
provider, or credential lifetime limits.

Deploy the updated verifier to every core and worker, and any separately deployed
egress proxy, before enabling no expiry. Older verifiers reject `exp: 0`.
Changing the setting affects newly issued tokens only; rotate the signing secret
if existing non-expiring tokens must be invalidated.
