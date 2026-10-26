import type { MemoryStrategy } from "../../memory/strategy.ts";
import { DEFAULT_CRON_TIMEZONE } from "../../cron/schedule.ts";
import { requiresDelegation } from "../../sessions/session-syscalls.ts";
import { type Destination, type ScopeId, turnSource } from "../../types.ts";
import { renderGatewayContext } from "../gateway-context.ts";
import { applyPromptVars, loadProtocolFile, type PromptVars } from "../../resolution/prompt-vars.ts";
import { cleanBrandingLabel, resolveBranding } from "../../resolution/branding.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { supportsScopeProfile } from "../../sandbox/sandbox.ts";
import { configuredConnectorProviders } from "../../credentials/connector-status.ts";
import { securityScreenChunks } from "../../security/security-posture.ts";
import { isIdeasConversation } from "../../onboarding/onboarding.ts";
import { INBOX_DIR, TURN_FILES_DIR, sharedFilesSystemSection, turnFileId } from "../attachments.ts";
import { swallowAs } from "../../util/errors.ts";
import { hashId } from "../../util/crypto.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import {
  MAX_AUTO_ATTACHMENT_SCREEN_BYTES,
  deliveryCandidatesFor,
  filterConnectorSkills,
  loadActiveBundles,
} from "./turn-helpers.ts";
import { currentTimeBlock, deliveryMenu, renderProjectHomeChannel } from "./prompt-blocks.ts";

import type { TurnCtx } from "./turn-context.ts";
import type { InboundScreen } from "./inbound-screen.ts";
import type { SecurityClassifier } from "./security-screen.ts";

const SHARED_CORE_MD = loadProtocolFile("shared-core");
const MODE_CONVERSATION_MD = loadProtocolFile("mode-conversation");
const MODE_AUTONOMOUS_MD = loadProtocolFile("mode-autonomous");
const MODE_FALLBACK_MD = loadProtocolFile("mode-fallback");
const DELEGATE_WORK_MD = loadProtocolFile("turn-delegate-work");
const EXTERNAL_SLACK_MD = loadProtocolFile("turn-external-slack");
const PRIVATE_SESSION_MESSAGE_MD = loadProtocolFile("turn-private-session-message");
const PROACTIVE_OPENER_MD = loadProtocolFile("turn-proactive-opener");
const IDEAS_CONVERSATION_MD = loadProtocolFile("turn-ideas-conversation");

export async function frameTurnPrompt(
  ctx: TurnCtx,
  turn: Pick<InboundScreen, "securityPolicy" | "enforceScreen" | "screenTrace" | "recordScreenRequest"> & {
    useMemory: boolean;
    context: Awaited<ReturnType<typeof resolveTurnContext>>;
    memoryScopeId: ScopeId;
    memoryStrategy: MemoryStrategy;
    classifySecurityData: SecurityClassifier;
  },
) {
  const {
    deps,
    input,
    actor,
    conversation,
    external,
    automatedTurn,
    sessionTurn,
    delegationEnabled,
    turnTimezone,
    resolution,
    scopeId,
  } = ctx;
  const {
    securityPolicy,
    enforceScreen,
    screenTrace,
    recordScreenRequest,
    useMemory,
    context,
    memoryScopeId,
    memoryStrategy,
    classifySecurityData,
  } = turn;
  const isWeb = input.surface === "web";
  const isSlack = input.surface === "slack";
  const surfaceTool = input.surface ?? "slack";
  const branding = await resolveBranding(deps.config, resolution.orgScopeId, deps.brandingDefault);
  const botName = branding.selfLabel ?? "QM";
  const orgName = branding.orgName ?? "this organization";
  const rawHandle = cleanBrandingLabel(input.gatewayContext?.botHandle?.replace(/^@/, ""), 40);
  const botHandle = rawHandle && rawHandle.toLowerCase() !== botName.toLowerCase() ? rawHandle : undefined;
  let modeName = "mode-fallback";
  if (input.surfaceTools) modeName = "mode-autonomous";
  else if (!automatedTurn && !(sessionTurn && input.envelopeWrapped) && (conversation.kind === "dm" || isWeb))
    modeName = "mode-conversation";
  let frameMd = MODE_FALLBACK_MD;
  if (modeName === "mode-autonomous") frameMd = MODE_AUTONOMOUS_MD;
  else if (modeName === "mode-conversation") frameMd = MODE_CONVERSATION_MD;
  const frameVars: PromptVars = {
    botName,
    surfaceTool,
    surfaceLabel: isWeb ? `the ${botName} web app` : (!isSlack && deps.surfaceLabel?.(surfaceTool)) || "Slack",
    conversationType: { dm: "private 1:1", group: "group conversation", channel: "channel conversation" }[
      conversation.kind
    ],
    web: isWeb,
    slack: isSlack,
  };
  if (modeName === "mode-conversation") {
    frameVars.userName = cleanBrandingLabel(actor.displayName, 80) ?? "there";
    frameVars.userEmail = actor.id.includes("@") ? actor.id : undefined;
  }
  const surfaceName =
    input.origin.kind === "automation" && input.origin.destination ? "slack" : (input.surface ?? "slack");
  const sessionSyscalls =
    !external &&
    deps.sessionSyscalls &&
    (delegationEnabled ||
      (await deps.featureFlags?.enabled("persistent_subagents", `personal:${actor.id}` as ScopeId)) === true)
      ? deps.sessionSyscalls
      : undefined;
  const delegateWork = requiresDelegation(input, delegationEnabled);
  let modeFrame = applyPromptVars(frameMd, frameVars);
  if (delegateWork) modeFrame += `\n\n${DELEGATE_WORK_MD}`;
  if (modeName === "mode-conversation" && input.proactiveOpener) {
    modeFrame += `\n${PROACTIVE_OPENER_MD}`;
  }
  const sharedCore = applyPromptVars(SHARED_CORE_MD, {
    botName,
    botHandle,
    orgName,
    web: isWeb,
    slack: isSlack,
    sessions: isWeb && surfaceName === "web" && Boolean(sessionSyscalls),
  });
  let systemPrompt = `${modeFrame}\n\n${resolution.systemPrompt}\n\n${sharedCore}`;
  if (external) systemPrompt += `\n\n${EXTERNAL_SLACK_MD}`;
  const turnContextBlocks: Record<string, string> = {};
  if (input.privateSessionMessage) systemPrompt += `\n\n${PRIVATE_SESSION_MESSAGE_MD}`;

  const scopeProfile = supportsScopeProfile(deps.sandbox)
    ? await deps.sandbox
        .profileFor(memoryScopeId)
        .catch(swallowAs("orchestrator: scope profile read", deps.sandbox.profile))
    : deps.sandbox.profile;
  const strategyLines = useMemory ? (memoryStrategy.promptLines?.() ?? []) : [];
  if (strategyLines.length) {
    systemPrompt += `\n\n${strategyLines.join("\n")}`;
  }

  const delivery = deliveryCandidatesFor(input.surface, input.deliveryTarget, input.deliveryCandidates, scopeId);
  const source = turnSource(input);
  if (source)
    for (const candidate of delivery.candidates) {
      candidate.account = source.account;
      candidate.workspaceId = source.workspaceId;
    }
  const defaultCandidate = delivery.candidates.find((c) => c.key === delivery.defaultKey);
  let defaultDestination: Destination | undefined;
  if (defaultCandidate) {
    defaultDestination = {
      type: defaultCandidate.type,
      target: defaultCandidate.target,
      ...(defaultCandidate.account ? { account: defaultCandidate.account } : {}),
      ...(defaultCandidate.workspaceId ? { workspaceId: defaultCandidate.workspaceId } : {}),
      ...(defaultCandidate.audienceScopeId ? { audienceScopeId: defaultCandidate.audienceScopeId } : {}),
    };
  } else if (input.surfaceTools && input.origin.kind === "automation" && input.origin.destination) {
    defaultDestination = input.origin.destination;
  }
  const cronBlock =
    delivery.candidates.length > 1 && deps.signingSecret && deps.apiBaseUrl
      ? `\n\n${deliveryMenu(delivery.candidates, delivery.defaultKey)}`
      : "";

  await deps.skillsReady;
  const configuredProviders =
    !external && deps.resolveConnectorClient
      ? await configuredConnectorProviders(deps.resolveConnectorClient).catch(
          swallowAs("orchestrator: configured connector providers", []),
        )
      : [];
  const carriedSkillScreens = new Map<string, Promise<boolean>>();
  const visibleSkillsForTurn = async (sources?: readonly string[]): Promise<SkillResolution[]> => {
    const current = await context.listSkills(sources);
    const resolved = filterConnectorSkills(current.skills, configuredProviders);
    const allowed: SkillResolution[] = [];
    for (const entry of resolved) {
      const skill = entry.skill;
      if (!skill || !current.sharingSources.includes(skill.scopeId) || securityPolicy.screening === "off") {
        allowed.push(entry);
        continue;
      }
      const snapshot = structuredClone(entry);
      const screenSkill = async () => {
        const bundles = structuredClone(
          deps.skillBundles
            ? await loadActiveBundles(deps.skillBundles, [snapshot]).catch(
                swallowAs("skill screening: load bundles", null),
              )
            : [],
        );
        const payload = JSON.stringify({ manifest: snapshot.skill!.manifest, bundles });
        const key = hashId([skill.scopeId, skill.id, payload], 64);
        let screen = carriedSkillScreens.get(key);
        if (!screen) {
          screen = (async () => {
            if (bundles === null || Buffer.byteLength(payload, "utf8") > MAX_AUTO_ATTACHMENT_SCREEN_BYTES) return false;
            for (const chunk of securityScreenChunks("tool_result:shared_skill", payload)) {
              const verdict = await classifySecurityData(chunk, actor.id, scopeId, recordScreenRequest, {
                ...screenTrace,
                hook: "tool_response",
                request: input.text,
                surface: "shared_skill",
                origin: input.origin.kind,
              });
              if (verdict?.decision !== "auto" || verdict.unscreened) return false;
            }
            return true;
          })();
          carriedSkillScreens.set(key, screen);
        }
        return { passed: await screen, bundles };
      };
      if (!enforceScreen) {
        allowed.push(entry);
        void screenSkill().catch(swallowAs("orchestrator: observed skill screen", undefined));
        continue;
      }
      const { passed, bundles } = await screenSkill();
      if (passed && bundles) allowed.push({ ...snapshot, screenedBundles: bundles });
      else
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.id,
          action: "sharing.skill_screen_blocked",
          resource: `skill:${skill.id}`,
          scopeLabel: scopeId,
          status: "refused",
          detail: JSON.stringify({ actor: actor.id, source: skill.scopeId, target: scopeId }),
        });
    }
    for (const entry of allowed) {
      if (!entry.skill || !current.sharingSources.includes(entry.skill.scopeId)) continue;
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "sharing.cross_context_read",
        resource: `skill:${entry.skill.id}`,
        scopeLabel: scopeId,
        detail: JSON.stringify({ actor: actor.id, source: entry.skill.scopeId, target: scopeId }),
      });
    }
    return allowed;
  };
  const skillSourceContext = await context.listSkills([scopeId, resolution.orgScopeId]);
  const otherSkillSources = skillSourceContext.skillSources
    .filter((source) => source !== scopeId && source !== resolution.orgScopeId)
    .sort();
  if (otherSkillSources.length)
    systemPrompt += `\n\nAdditional skill sources: ${otherSkillSources.join(", ")}. Use skills list/search with source to discover their authorized skills; read with the same source.`;
  const nativeSkills = filterConnectorSkills(skillSourceContext.skills, configuredProviders);
  const transferId = turnFileId(input.runId, input.attempt);
  const turnSessionDir = `${TURN_FILES_DIR}/${hashId([conversation.threadRef], 24)}`;
  const turnFilesDir = `${turnSessionDir}/${transferId}`;
  const turnInboxDir = `${turnFilesDir}/${INBOX_DIR}`;

  if (!external && deps.deploymentLayer?.hints.length) {
    systemPrompt += `\n\n## Deployment tool hints\n${deps.deploymentLayer.hints.map((hint) => `- ${hint}`).join("\n")}`;
  }
  const gatewayBlock = renderGatewayContext(input.surface, input.gatewayContext);
  if (gatewayBlock) turnContextBlocks["Where you are"] = gatewayBlock;
  const homeChannel =
    conversation.kind === "group" && conversation.channelRef
      ? await deps.managedGroups
          ?.slackChannel?.(conversation.channelRef)
          .catch(swallowAs("orchestrator: project home channel read", undefined))
      : undefined;
  if (homeChannel) turnContextBlocks["Project home channel"] = renderProjectHomeChannel(homeChannel.channelName);
  turnContextBlocks["Where scheduled tasks post"] = cronBlock;
  const sharedFilesBlock = sharedFilesSystemSection(resolution.grantedHandles);
  if (sharedFilesBlock) turnContextBlocks["Files shared with you"] = sharedFilesBlock;

  const timeBlock = currentTimeBlock(turnTimezone ?? DEFAULT_CRON_TIMEZONE, Date.now());
  let memoryContext = "a channel";
  if (conversation.kind === "dm") memoryContext = "a direct message";
  else if (conversation.channelName) memoryContext = `#${conversation.channelName}`;
  else if (conversation.kind === "group") memoryContext = "a group conversation";
  const memoryHeading = `\n\n## What you remember\nYou're in ${memoryContext}; use these authorized memories freely, but preferences tagged with another scope heading or \`(said in …)\` apply only there.\n\n`;

  const onboardingBlock = isIdeasConversation(input) ? IDEAS_CONVERSATION_MD : "";
  return {
    systemPrompt,
    surfaceName,
    sessionSyscalls,
    delegateWork,
    turnContextBlocks,
    scopeProfile,
    delivery,
    defaultDestination,
    configuredProviders,
    visibleSkillsForTurn,
    nativeSkills,
    transferId,
    turnSessionDir,
    turnFilesDir,
    turnInboxDir,
    timeBlock,
    memoryHeading,
    onboardingBlock,
  };
}
