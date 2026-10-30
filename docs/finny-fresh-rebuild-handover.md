# Finny fresh rebuild handover

- **Decision:** abandon PR `11mirror/qm#1`; never merge `codex/qm-host-attestation`.
- **Reference only:** retain commit `44384fc55e2687dfd771f7421fce4160a2216477` for forensic lookup.
- **Reason:** the branch is `+19,260/-497` lines across 173 files and mixes Finny, Pi, QM auth, persistence, MCP, Slack, providers, and release control.
- **Reason:** the 10-hour brief grew into a 504-line implementation diary; later review fixes were treated as new architecture.
- **Reason:** security problems caused more Finny-specific plumbing instead of removal of the wrong boundary.
- **Reason:** report coverage became compiler code instead of capability-pack data.

- **Safely copy:** reviewed finance `SKILL.md` content and required references after a fresh secret/provenance scan.
- **Safely copy:** capability-pack field meanings from `finny-skills/capabilities/*.json`.
- **Safely copy:** deterministic accounting rules and approved NetSuite query semantics as requirements.
- **Safely copy:** user-visible success, failure, restart, and adversarial acceptance cases.
- **Safely copy:** typed evidence, verification, fail-closed release, and web/Slack parity requirements.
- **Regenerate:** manifests, digests, indexes, fixtures, and tests in the fresh repository.
- **Example only:** `ap-gl-control-balance.json`; it is not the harness architecture.
- **Fixture only:** `synthetic-inventory-velocity.json`; it is not production capability authority.

- **Reference only:** `src/finny/capability-pack.ts` for attempted pack structure.
- **Reference only:** `src/finny/knowledge-index.ts` for provenance needs.
- **Reference only:** `src/finny/operation-compiler.ts` for reusable finance primitives.
- **Reference only:** `src/finny/accounting-validator.ts` for deterministic checks.
- **Reference only:** `src/finny/provider-clients.ts` for reviewed NetSuite request behavior.
- **Reference only:** Finny tests for scenarios; rewrite them against the fresh public boundary.

- **Never copy:** `src/finny/credential-brokered-finance-service.ts` or `default-finance-service.ts`.
- **Never copy:** `src/finny/pi-profile.ts` or custom runtime-constraint plumbing.
- **Never copy:** Finny-specific changes under `src/core`, `src/harness`, `src/api`, `src/config.ts`, or `src/wiring.ts`.
- **Never copy:** custom Finny auth, credential, approval, session, retry, replay, delivery, or run-store layers.
- **Never copy:** Finny-specific MCP/Slack attestation as part of the harness.
- **Never copy:** the Golden Loop implementation wholesale; preserve only its required outcomes.
- **Never copy:** generated artifacts, local databases, sessions, tokens, keys, or secrets.

- **Credentials:** provision NetSuite and optional Hindsight only through QM credential management.
- **Credentials:** store plaintext only in QM's encrypted organization credential store.
- **Credentials:** keep only opaque identifiers in deployment configuration.
- **Credentials:** let QM authorize and inject access when the finance tool executes.
- **Credentials:** never place secrets in Git, `.env`, skills, packs, prompts, logs, traces, fixtures, or handovers.
- **Credentials:** Finny must never read QM credential tables or pass auth callbacks through Pi.

- **Ownership:** QM owns identity, credentials, authorization, durability, approvals, retries, surfaces, and delivery.
- **Ownership:** Pi owns the configured model/tool loop.
- **Ownership:** the deployment owns Finny skills, capability packs, finance services, and validators.
- **Boundary:** expose one small QM-native finance tool to Pi.
- **Boundary:** capability packs define semantics, sources, transforms, verification, and presentation.
- **Boundary:** the tool uses QM-authorized provider access and returns typed evidence.
- **Boundary:** web and Slack use the same deployment, Pi harness, tool, packs, and validators.

- **Build:** create a fresh private QM package-deployment repository pinned to released `@yc-software/qm`.
- **Build:** keep QM core unchanged for the first working slice.
- **Build:** configure QM's existing Pi harness with one real supported model.
- **Build:** install the reviewed Finny skills through the deployment skill path.
- **Build:** provision real credentials through QM credential management.
- **Build:** add one deployment-owned finance tool through QM's documented tool interface.
- **Build:** add one manifest-validated generic capability-pack loader.
- **Build:** add the smallest deterministic executor and verification result needed for one real read.
- **Build:** run one real Pi request through QM web and real read-only NetSuite.
- **Build:** add a materially different second capability pack without changing harness code.
- **Build:** reject the design if the second pack needs new Pi, QM, auth, session, or delivery paths.
- **Build:** prove restart durability using QM-owned persistence.
- **Build:** attempt Slack only after the identical web path succeeds.
- **Build:** create a QM source fork only after documenting and reproducing a missing platform primitive.

- **Guardrail:** never implement AR, AP, receipts, aging, migration, or inventory as separate harnesses.
- **Guardrail:** never rebuild Pi's loop or QM's credentials, approvals, sessions, retries, or Slack delivery.
- **Guardrail:** never make MCP mandatory or add a second runtime, scheduler, or persistence authority.
- **Guardrail:** never fix a removable bespoke boundary by extending it.
- **Guardrail:** never claim success from fixtures, test counts, or model assertions.

- **Done:** real Pi invokes the same finance tool for two different capability packs.
- **Done:** QM authorizes the exact credential at execution time.
- **Done:** a real read-only NetSuite request produces typed evidence and deterministic verification.
- **Done:** no finance claim is released before verification.
- **Done:** restart loses neither credential binding nor run state.
- **Done:** the fresh repository contains only code required by the demonstrated path.
