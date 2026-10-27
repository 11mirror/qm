import { refusalFallbackModelId } from "./turn-recovery.ts";
import { type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ProviderTurnError } from "../core/turn-error.ts";
import { swallow } from "../util/errors.ts";
import { auxiliaryModelForProvider, resolveModel, contextTokenBudgetForModel } from "../model/pi-models.ts";
import { type HarnessCompactInput, type HarnessDetectInput, type HarnessDetectResult } from "./harness.ts";
import { summarizeHistory } from "./history-summary.ts";
import { countTokens } from "../util/tokens.ts";
import {
  parseSecurityScreenVerdict,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
} from "../security/security-screen.ts";
import {
  buildDetectionPrompt,
  parseDetectVerdict,
  renderDetectPrompt,
  TITLE_GENERATION_PROMPT,
  titleUserPrompt,
  ACK_EMOJI_PROMPT,
  APPROVAL_SUMMARY_PROMPT,
  sanitizeTitle,
} from "./pi-aux-prompts.ts";
import { buildModelRuntime, complete } from "./pi-model-runtime.ts";
import type { PiHarnessContext } from "./pi-harness.ts";
import type { HarnessSecurityScreenInput } from "./harness.ts";
import type { SecurityScreenVerdict } from "../security/security-screen.ts";
async function keyedOneShot(
  ctx: PiHarnessContext,
  modelId: string,
  systemPrompt: string,
  prompt: string,
  extra?: { signal?: AbortSignal; thinkingLevel?: ModelThinkingLevel },
): Promise<string | undefined | null> {
  const { resolveProviderKeys, modelGateway, requiredModel, keyForModel } = ctx;
  const model = requiredModel(modelId);
  const providerKeys = await resolveProviderKeys();
  if (!keyForModel(providerKeys, model)) return null;
  return complete(model, providerKeys, systemPrompt, prompt, { modelGateway, ...extra });
}

export async function piShouldRespond(ctx: PiHarnessContext, detect: HarnessDetectInput): Promise<HarnessDetectResult> {
  const { detectModelId, resolveProviderKeys, modelGateway, requiredModel, keyForModel } = ctx;
  const modelId = detectModelId();
  const model = requiredModel(modelId);
  const providerKeys = await resolveProviderKeys();
  if (!keyForModel(providerKeys, model)) return { respond: true };
  const detectSystemPrompt = buildDetectionPrompt(detect.reactionGuidance);
  const prompt = renderDetectPrompt(detect);
  detect.recordModelCall({
    model: modelId,
    inputTokens: countTokens(detectSystemPrompt) + countTokens(prompt),
    entryCount: detect.history.length,
  });
  const out = ((await complete(model, providerKeys, detectSystemPrompt, prompt, { modelGateway })) ?? "").trim();
  return parseDetectVerdict(out, Boolean(detect.reactionGuidance?.trim()));
}

export async function piCompactHistory(ctx: PiHarnessContext, input: HarnessCompactInput): Promise<string> {
  const { resolveModelId, resolveProviderKeys, modelGateway, companyServedId, requiredModel, opts } = ctx;
  const primaryId = resolveModelId();
  const providerKeys = await resolveProviderKeys();
  const runtime = await buildModelRuntime(providerKeys, modelGateway);
  const summarize = (compactModelId: string) =>
    summarizeHistory(input.history, requiredModel(compactModelId), (summaryModel, context, options) => {
      input.recordModelCall({
        model: compactModelId,
        inputTokens: countTokens(context.systemPrompt ?? "") + countTokens(JSON.stringify(context.messages)),
        entryCount: input.history.length,
      });
      return runtime.streamSimple(summaryModel, context, options);
    });
  try {
    return await summarize(primaryId);
  } catch (error) {
    const fallbackId = refusalFallbackModelId(
      primaryId,
      opts?.resolveFallbackRuntime?.()?.modelId,
      (id) => !!resolveModel(companyServedId(id)),
    );
    if (
      !(error instanceof ProviderTurnError) ||
      error.code !== "refusal" ||
      !fallbackId ||
      !resolveModel(companyServedId(fallbackId)) ||
      companyServedId(fallbackId) === companyServedId(primaryId)
    )
      throw error;
    console.error(`[pi] compaction failed on ${primaryId}; retrying on fallback model ${fallbackId}: ${error.message}`);
    return summarize(fallbackId);
  }
}

export function piContextTokenBudget(ctx: PiHarnessContext, _scopeLabel?: string, model?: string): number | undefined {
  const { resolveModelId } = ctx;
  const id = model && resolveModel(model) ? model : resolveModelId();
  return contextTokenBudgetForModel(id);
}

export async function piOneShot(
  ctx: PiHarnessContext,
  systemPrompt: string,
  prompt: string,
): Promise<string | undefined> {
  const { resolveModelId } = ctx;
  return (await keyedOneShot(ctx, resolveModelId(), systemPrompt, prompt)) ?? undefined;
}

export async function piJudge(
  ctx: PiHarnessContext,
  systemPrompt: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { judgeModelId } = ctx;
  const out = await keyedOneShot(ctx, judgeModelId(), systemPrompt, prompt, {
    signal,
    thinkingLevel: "low",
  });
  return out ?? undefined;
}

export async function piScreenSecurity(
  ctx: PiHarnessContext,
  {
    payload,
    modelId: configuredScreenModel,
    systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT,
    signal,
    recordModelCall,
    recordLlmRequest,
  }: HarnessSecurityScreenInput,
): Promise<SecurityScreenVerdict | undefined> {
  const { detectModelId, resolveProviderKeys, modelGateway, requiredModel, keyForModel } = ctx;
  try {
    const modelId = configuredScreenModel ?? detectModelId();
    const model = requiredModel(modelId);
    const providerKeys = await resolveProviderKeys();
    if (!keyForModel(providerKeys, model)) return undefined;
    recordModelCall({
      model: modelId,
      inputTokens: countTokens(systemPrompt) + countTokens(payload),
      entryCount: 1,
    });
    await recordLlmRequest?.({
      turnSeq: null,
      step: SECURITY_SCREEN_STEP,
      model: modelId,
      promptEnvelope: { system: systemPrompt, messages: [{ role: "user", content: payload }] },
      truncated: false,
    });
    return parseSecurityScreenVerdict(
      await complete(model, providerKeys, systemPrompt, payload, {
        signal,
        modelGateway,
      }),
    );
  } catch (e) {
    swallow("pi: security screen", e);
    return undefined;
  }
}

export async function piPickAckEmoji(
  ctx: PiHarnessContext,
  text: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  const { resolveProviderKeys, modelGateway, requiredModel, keyForModel } = ctx;
  if (!text.trim() || candidates.length === 0) return undefined;
  const ackModelId = auxiliaryModelForProvider("anthropic");
  if (!ackModelId) return undefined;
  try {
    const model = requiredModel(ackModelId);
    const providerKeys = await resolveProviderKeys();
    if (!keyForModel(providerKeys, model)) return undefined;
    const prompt = `Candidates: ${candidates.join(", ")}\n\nMessage: ${text.slice(0, 2000)}`;
    const raw = await complete(model, providerKeys, ACK_EMOJI_PROMPT, prompt, {
      modelGateway,
      thinkingLevel: "off",
      maxTokens: 64,
      retry: false,
      signal: AbortSignal.timeout(2_000),
    });
    if (!raw) return undefined;
    const emoji = (JSON.parse(raw.replace(/```json|```/g, "").trim()) as { emoji?: unknown }).emoji;
    return typeof emoji === "string" && candidates.includes(emoji) ? emoji : undefined;
  } catch (e) {
    swallow("pi: ack emoji", e);
    return undefined;
  }
}

export async function piGenerateTitle(ctx: PiHarnessContext, transcript: string): Promise<string | undefined> {
  const { titleModelId } = ctx;
  if (!transcript.trim()) return undefined;
  const out = await keyedOneShot(ctx, titleModelId(), TITLE_GENERATION_PROMPT, titleUserPrompt(transcript));
  return out === null ? undefined : sanitizeTitle(out);
}

export async function piSummarizeApproval(
  ctx: PiHarnessContext,
  command: string,
  reason: string,
  purpose?: string,
): Promise<string | undefined> {
  const { titleModelId } = ctx;
  if (!command.trim()) return undefined;
  const prompt = [
    `Policy flagged this as: ${reason}`,
    purpose ? `Agent's stated purpose: ${purpose}` : "",
    "",
    "Command:",
    command.slice(0, 4000),
  ].join("\n");
  const out = (await keyedOneShot(ctx, titleModelId(), APPROVAL_SUMMARY_PROMPT, prompt))?.trim();
  if (!out || out === "NONE") return undefined;
  return out.replace(/^["']|["']$/g, "").slice(0, 300);
}
