import { refusalFallbackModelId } from "./turn-recovery.ts";
import { type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type TSchema } from "typebox";
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
  AckEmojiAnswer,
  ApprovalSummaryAnswer,
  buildDetectionPrompt,
  DetectAnswer,
  detectResult,
  renderDetectPrompt,
  TITLE_GENERATION_PROMPT,
  TitleAnswer,
  titleFromAnswer,
  titleUserPrompt,
  ACK_EMOJI_PROMPT,
  APPROVAL_SUMMARY_PROMPT,
} from "./pi-aux-prompts.ts";
import { buildModelRuntime, complete, completeStructured, type StructuredAnswer } from "./pi-model-runtime.ts";
import type { PiModelAccess } from "./pi-model-access.ts";
import type { HarnessSecurityScreenInput } from "./harness.ts";
import type { SecurityScreenVerdict } from "../security/security-screen.ts";
async function keyed(access: PiModelAccess, modelId: string) {
  const model = access.model(modelId);
  const providerKeys = await access.providerKeys();
  return access.keyFor(providerKeys, model) ? { model, providerKeys } : null;
}

export async function piOneShot(
  access: PiModelAccess,
  modelId: string,
  systemPrompt: string,
  prompt: string,
  extra?: { signal?: AbortSignal; thinkingLevel?: ModelThinkingLevel },
): Promise<string | undefined> {
  const k = await keyed(access, modelId);
  return k
    ? complete(k.model, k.providerKeys, systemPrompt, prompt, { modelGateway: access.gateway, ...extra })
    : undefined;
}

export async function piShouldRespond(
  access: PiModelAccess,
  detectModelId: () => string,
  detect: HarnessDetectInput,
): Promise<HarnessDetectResult> {
  const modelId = detectModelId();
  const k = await keyed(access, modelId);
  if (!k) return { respond: true };
  const detectSystemPrompt = buildDetectionPrompt(detect.reactionGuidance);
  const prompt = renderDetectPrompt(detect);
  detect.recordModelCall({
    model: modelId,
    inputTokens: countTokens(detectSystemPrompt) + countTokens(prompt),
    entryCount: detect.history.length,
  });
  const answer = await completeStructured(k.model, k.providerKeys, detectSystemPrompt, prompt, DetectAnswer, {
    modelGateway: access.gateway,
  });
  return answer ? detectResult(answer, Boolean(detect.reactionGuidance?.trim())) : { respond: false };
}

export async function piCompactHistory(
  access: PiModelAccess,
  primaryModelId: () => string,
  fallbackModelId: () => string | undefined,
  input: HarnessCompactInput,
): Promise<string> {
  const primaryId = primaryModelId();
  const providerKeys = await access.providerKeys();
  const runtime = await buildModelRuntime(providerKeys, access.gateway);
  const summarize = (compactModelId: string) =>
    summarizeHistory(
      input.history,
      access.model(compactModelId),
      (summaryModel, context, options) => {
        input.recordModelCall({
          model: compactModelId,
          inputTokens: countTokens(context.systemPrompt ?? "") + countTokens(JSON.stringify(context.messages)),
          entryCount: input.history.length,
        });
        return runtime.streamSimple(summaryModel, context, options);
      },
      input.summaryTokenBudget,
    );
  try {
    return await summarize(primaryId);
  } catch (error) {
    const fallbackId = refusalFallbackModelId(
      primaryId,
      fallbackModelId(),
      (id) => !!resolveModel(access.servedId(id)),
    );
    if (
      !(error instanceof ProviderTurnError) ||
      error.code !== "refusal" ||
      !fallbackId ||
      access.servedId(fallbackId) === access.servedId(primaryId)
    )
      throw error;
    console.error(`[pi] compaction failed on ${primaryId}; retrying on fallback model ${fallbackId}: ${error.message}`);
    return summarize(fallbackId);
  }
}

export function piContextTokenBudget(primaryModelId: () => string, model?: string): number | undefined {
  const id = model && resolveModel(model) ? model : primaryModelId();
  return contextTokenBudgetForModel(id);
}

export async function piScreenSecurity(
  access: PiModelAccess,
  detectModelId: () => string,
  {
    payload,
    modelId: configuredScreenModel,
    systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT,
    signal,
    recordModelCall,
    recordLlmRequest,
  }: HarnessSecurityScreenInput,
): Promise<SecurityScreenVerdict | undefined> {
  try {
    const modelId = configuredScreenModel ?? detectModelId();
    const k = await keyed(access, modelId);
    if (!k) return undefined;
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
      await complete(k.model, k.providerKeys, systemPrompt, payload, {
        signal,
        modelGateway: access.gateway,
      }),
    );
  } catch (e) {
    swallow("pi: security screen", e);
    return undefined;
  }
}

export async function piPickAckEmoji(
  access: PiModelAccess,
  text: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  if (!text.trim() || candidates.length === 0) return undefined;
  const ackModelId = auxiliaryModelForProvider("anthropic");
  if (!ackModelId) return undefined;
  try {
    const k = await keyed(access, ackModelId);
    if (!k) return undefined;
    const prompt = `Candidates: ${candidates.join(", ")}\n\nMessage: ${text}`;
    const answer = await completeStructured(k.model, k.providerKeys, ACK_EMOJI_PROMPT, prompt, AckEmojiAnswer, {
      modelGateway: access.gateway,
      thinkingLevel: "off",
      maxTokens: 64,
      retry: false,
      signal: AbortSignal.timeout(2_000),
    });
    return answer?.ok && candidates.includes(answer.value.emoji) ? answer.value.emoji : undefined;
  } catch (e) {
    swallow("pi: ack emoji", e);
    return undefined;
  }
}

async function keyedStructured<T extends TSchema>(
  access: PiModelAccess,
  modelId: string,
  systemPrompt: string,
  prompt: string,
  schema: T,
): Promise<StructuredAnswer<T> | undefined> {
  const k = await keyed(access, modelId);
  return k
    ? completeStructured(k.model, k.providerKeys, systemPrompt, prompt, schema, { modelGateway: access.gateway })
    : undefined;
}

export async function piGenerateTitle(
  access: PiModelAccess,
  titleModelId: () => string,
  transcript: string,
): Promise<string | undefined> {
  if (!transcript.trim()) return undefined;
  const modelId = titleModelId();
  const prompt = titleUserPrompt(transcript, contextTokenBudgetForModel(modelId));
  const answer = await keyedStructured(access, modelId, TITLE_GENERATION_PROMPT, prompt, TitleAnswer);
  return answer ? titleFromAnswer(answer) : undefined;
}

export async function piSummarizeApproval(
  access: PiModelAccess,
  titleModelId: () => string,
  command: string,
  reason: string,
  purpose?: string,
): Promise<string | undefined> {
  if (!command.trim()) return undefined;
  const prompt = [
    `Policy flagged this as: ${reason}`,
    purpose ? `Agent's stated purpose: ${purpose}` : "",
    "",
    "Command:",
    command,
  ].join("\n");
  const answer = await keyedStructured(access, titleModelId(), APPROVAL_SUMMARY_PROMPT, prompt, ApprovalSummaryAnswer);
  return (answer?.ok && answer.value.summary?.trim()) || undefined;
}
