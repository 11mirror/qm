import type { Session } from "../../types.ts";
import { resolveBrowserModel } from "../../model/browser-model.ts";
import { type Destination } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { type PublicServiceCredential } from "../../credentials/keychain.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  SANDBOX_CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  BROWSER_MODEL_AUD,
  OAUTH_CONSENT_AUD,
  EGRESS_PROXY_AUD,
  type CapabilityClaims,
} from "../../auth/capability-token.ts";
import { swallowAs } from "../../util/errors.ts";
import { deliveryCandidatesFor, egressClaimAllowingControlPlane } from "./turn-helpers.ts";
import type { EgressPolicy } from "../../types.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import { tenant } from "../../tenant.ts";
import {
  addCredentialToCatalog,
  createCatalogState,
  credentialBroker,
  grantedServiceCredSlugs,
  registerBrokeredTools,
  registerConnectorCredentials,
  registerKeychainCredentials,
  registerServiceCredentials,
  type CatalogState,
} from "./credential-registry.ts";
import type { TurnCtx } from "./turn-context.ts";

interface CatalogTurn {
  strictReadOnly: boolean;
  sharingSources: Awaited<ReturnType<typeof resolveTurnContext>>["sharingSources"];
  delivery: ReturnType<typeof deliveryCandidatesFor>;
  defaultDestination: Destination | undefined;
  session: Session;
}

export async function buildCredentialCatalog(ctx: TurnCtx, turn: CatalogTurn) {
  const { deps, input, actor, conversation, external, serviceAllowed, allInternal, liveAuthorTurn } = ctx;
  const { resolution, scopeId } = ctx;
  const { strictReadOnly, sharingSources } = turn;
  const openSpeakerKeychain =
    liveAuthorTurn && conversation.kind !== "dm" && sharingSources.includes(personalScope(actor.id));
  const openAutomationKeychain =
    !external &&
    input.origin.kind === "automation" &&
    input.origin.useOwnerKeychain === true &&
    conversation.kind !== "dm" &&
    !!deps.isCurrentSharedScopeMember &&
    (await isOpenScopeMember({
      actorId: actor.id,
      scope: scopeId,
      isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
    }));
  const c = createCatalogState(ctx, strictReadOnly, openSpeakerKeychain, openAutomationKeychain);
  const { connectorEnv } = c;
  const addCredential = addCredentialToCatalog.bind(null, c);
  const catalogBroker = credentialBroker(c, []);
  await registerKeychainCredentials(c, addCredential, catalogBroker);
  await registerConnectorCredentials(c, addCredential, catalogBroker);
  let serviceCredRecords: PublicServiceCredential[] = [];
  let grantedCredSlugs = new Set<string>();
  if (!strictReadOnly && deps.serviceCreds) {
    serviceCredRecords = (await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId)).filter((record) =>
      serviceAllowed(record.slug),
    );
    if (serviceCredRecords.length > 0) grantedCredSlugs = await grantedServiceCredSlugs(c, serviceCredRecords);
  }
  if (!strictReadOnly && allInternal && deps.serviceCreds) {
    const browseSteps = deps.config?.setting("browseMaxSteps", tenant().orgScope);
    if (browseSteps && !("BROWSE_LAB_MAX_STEPS" in connectorEnv))
      connectorEnv.BROWSE_LAB_MAX_STEPS = String(browseSteps);
  }
  const browserSelection =
    !strictReadOnly && allInternal
      ? await resolveBrowserModel({
          actorId: actor.id,
          config: deps.config,
          credentials: deps.userModelCredentials,
          companyModel: deps.resolveBaseModelId?.(),
        })
      : undefined;
  if (browserSelection) {
    connectorEnv.BROWSE_LAB_MODEL_PROVIDER = "managed";
    connectorEnv.BROWSE_LAB_MODEL = browserSelection.model ?? "unavailable";
  }
  c.sandboxTokenExpiry = Date.now() + SANDBOX_CAPABILITY_TTL_MS;
  const { actorIsOrgAdmin, controlClaims } = await mintControlTokens(c, turn, browserSelection);
  const egressTokenForPolicy = (egress: EgressPolicy) => mintEgressToken(c, egress);
  const egressTokenForTurn = await egressTokenForPolicy(resolution.egress);
  await registerServiceCredentials(c, addCredential, catalogBroker);
  registerBrokeredTools(c, addCredential);
  return {
    openSpeakerKeychain,
    ownerAuthAvailable: c.isolateOwnerKeychain,
    connectorEnv,
    commandCredentials: c.commandCredentials,
    credentialDescriptions: c.credentialDescriptions,
    credentialBroker: credentialBroker.bind(null, c),
    registerKeychainCredentials: registerKeychainCredentials.bind(null, c),
    registerConnectorCredentials: registerConnectorCredentials.bind(null, c),
    serviceCredRecords,
    grantedCredSlugs,
    actorIsOrgAdmin,
    controlClaims,
    scopeAttestation: c.scopeAttestation,
    egressTokenForPolicy,
    egressTokenForTurn,
    registerServiceCredentials: registerServiceCredentials.bind(null, c),
    openAutomationKeychain,
  };
}

async function mintControlTokens(
  c: CatalogState,
  turn: CatalogTurn,
  browserSelection: Awaited<ReturnType<typeof resolveBrowserModel>> | undefined,
) {
  const { deps, input, actor, conversation, external, allInternal, liveTurn, liveAuthorTurn, automatedTurn } = c;
  const { scopeId, turnTimezone, strictReadOnly, connectorEnv, scopeAttestation, sandboxTokenExpiry } = c;
  const { openSpeakerKeychain, openAutomationKeychain } = c;
  const { delivery, defaultDestination: destination, session } = turn;
  let actorIsOrgAdmin = false;
  let controlClaims: CapabilityClaims | undefined;
  if (!strictReadOnly && deps.signingSecret && deps.apiBaseUrl) {
    connectorEnv.AGENT_API_URL = deps.apiBaseUrl;
    if (deps.admin && liveAuthorTurn) {
      const status = await deps.admin
        .adminStatusOf(actor)
        .catch(swallowAs("orchestrator: admin status for turn", { isAdmin: false }));
      actorIsOrgAdmin = status.isAdmin;
    }
    const turnSurface = input.surface === "web" ? "web" : (session.surface ?? input.surface);
    controlClaims = {
      ...scopeAttestation,
      aud: CONTROL_PLANE_AUD,
      ...(!external &&
      allInternal &&
      (scopeId === personalScope(actor.id) || openSpeakerKeychain || openAutomationKeychain)
        ? { ownerConnections: true }
        : {}),
      exp: sandboxTokenExpiry,
      ...(turnTimezone ? { timezone: turnTimezone } : {}),
      ...(destination ? { destination } : {}),
      ...(delivery.candidates.length > 0 ? { destinations: delivery.candidates } : {}),
      ...(delivery.defaultKey ? { defaultDestinationKey: delivery.defaultKey } : {}),
      ...(!external && conversation.kind !== "dm"
        ? { keychainMembers: conversation.audience.filter((p) => p.type === "internal") }
        : {}),
      ...(conversation.kind === "dm" ||
      conversation.kind === "group" ||
      conversation.isPrivate === true ||
      conversation.isMpim === true
        ? { privateScope: true }
        : {}),
      ...(liveAuthorTurn ? { liveAuthor: true } : {}),
      ...(automatedTurn ? { triggered: true } : {}),
      ...(!liveTurn && input.unattendedGrants ? { grants: input.unattendedGrants } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      sessionId: session.id,
      runAttempt: input.attempt,
      runLeaseToken: input.runLeaseToken,
      threadRef: conversation.threadRef,
      ...(turnSurface ? { surface: turnSurface } : {}),
    };
    connectorEnv.AGENT_API_TOKEN = await mintCapabilityToken(
      controlClaims,
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
    if (browserSelection) {
      connectorEnv.BROWSE_LAB_BASE_URL = `${deps.apiBaseUrl.replace(/\/+$/, "")}/v1/browser-model`;
      connectorEnv.BROWSE_LAB_MODEL_TOKEN = await mintCapabilityToken(
        {
          ...scopeAttestation,
          aud: BROWSER_MODEL_AUD,
          browserModel: browserSelection.model ?? "unavailable",
          browserAccount: browserSelection.account,
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        deps.capabilitySecret ?? deps.signingSecret,
      );
    }
    connectorEnv.AGENT_OAUTH_CONSENT_TOKEN = await mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: OAUTH_CONSENT_AUD,
        exp: sandboxTokenExpiry,
      },
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
  }
  return { actorIsOrgAdmin, controlClaims };
}

async function mintEgressToken(c: CatalogState, egress: EgressPolicy): Promise<string | undefined> {
  const { deps, strictReadOnly, scopeAttestation, sandboxTokenExpiry } = c;
  const egressSecret = deps.capabilitySecret ?? deps.signingSecret;
  if (strictReadOnly || !egressSecret) return undefined;
  return mintCapabilityToken(
    {
      ...scopeAttestation,
      aud: EGRESS_PROXY_AUD,
      egress: egressClaimAllowingControlPlane(egress, deps.apiBaseUrl ?? ""),
      exp: sandboxTokenExpiry,
    },
    egressSecret,
    deps.capabilityTokenCompression,
  );
}
