import type { SessionEntry } from "../types.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult } from "../harness/harness.ts";
import { createPiHarness, type PiHarnessOptions } from "../harness/pi-harness.ts";
import type { FinanceService } from "./finance.ts";
import type { FinanceDiagnosticSink } from "./finance-failure.ts";
import { createFinnyGoldenLoop, replayFinnyLedger, type FinnyGoldenLoopState } from "./golden-loop.ts";
import { createFinnyFinanceTool } from "./native-finance-tool.ts";
import { finnyWorkflowRunIdFromEntries, type FinnyRunStore } from "./run-store.ts";
import type { FinnyTraceBlocker } from "./trace.ts";
import type { FinnyKnowledgeIndex } from "./knowledge-index.ts";

export interface FinnyPiProfileOptions {
  modelId: string;
  runStore: FinnyRunStore;
  knowledgeIndex?: FinnyKnowledgeIndex | Promise<FinnyKnowledgeIndex>;
}

export type CreateFinnyPiHarnessOptions = Omit<PiHarnessOptions, "modelId" | "defaultModelId" | "nativeTools"> & {
  modelId: string;
  financeService: FinanceService;
  runStore: FinnyRunStore;
  diagnostics?: FinanceDiagnosticSink;
  knowledgeIndex?: FinnyKnowledgeIndex | Promise<FinnyKnowledgeIndex>;
};

const FINNY_SYSTEM_PROMPT = `

Finny deployment contract (host enforced): profile=finny, harness=pi.
Call the native finance resource once with the user's complete finance request. The host compiles Finance IR and
drives every Golden Loop stage; never invent SQL, stage arguments, evidence, approval, verification, or delivery
proof. Model text and self-reported verification never advance a gate. Never request or expose credential values.
A final finance claim is released only after the host reports DELIVERY_ELIGIBLE.`;

function blockerFromEntries(entries: readonly Pick<SessionEntry, "type" | "payload">[]): FinnyTraceBlocker | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "tool_result" || !entry.payload || typeof entry.payload !== "object") continue;
    const value = (entry.payload as Record<string, unknown>).finnyBlocker;
    if (!value || typeof value !== "object") continue;
    const blocker = value as Partial<FinnyTraceBlocker>;
    if (
      ["clarify", "preflight", "plan", "source", "artifact", "verify"].includes(blocker.action ?? "") &&
      (blocker.code === "blocked_external" || blocker.code === "finance_error")
    )
      return blocker as FinnyTraceBlocker;
  }
  return undefined;
}

function blockedReply(state: FinnyGoldenLoopState, result: HarnessTurnResult, blocker?: FinnyTraceBlocker): string {
  if (result.pendingApprovals?.length)
    return `Finny is blocked at ${state.stage} until the displayed human approval is granted.`;
  if (blocker) {
    const action = blocker.action.toUpperCase();
    const dependency = blocker.dependency === "netsuite" ? "NetSuite" : "The finance provider";
    switch (blocker.cause) {
      case "unsupported_template":
        return `This finance request is not yet supported by the reviewed compiler. No finance source was called and no figure was released.`;
      case "schema_mapping_required":
        return `This finance request needs a reviewed capability or schema mapping before execution. No finance source was called and no figure was released.`;
      case "credential_missing":
        return `${dependency} is not configured for this Finny deployment. Add the required opaque credential binding, then retry; no finance figure was released.`;
      case "invalid_config":
        return `${dependency} configuration is invalid. An operator must correct it before retrying; no finance figure was released.`;
      case "provider_auth":
        return `${dependency} rejected authentication during ${action}. An operator must refresh the credential binding; no finance figure was released.`;
      case "provider_timeout":
        return `${dependency} timed out during ${action}. A source call was attempted; retry is safe, and no finance figure was released.`;
      case "provider_rate_limited":
        return `${dependency} rate-limited ${action}. Retry after the provider recovers; no finance figure was released.`;
      case "provider_unavailable":
        return `${dependency} was unavailable during ${action}. ${blocker.retryable ? "Retry is safe" : "Operator action is required"}; no finance figure was released.`;
      case "invalid_response":
        return `${dependency} returned an invalid response during ${action}. Finny rejected it and released no finance figure.`;
      case "verification_failed":
        return `Finny verification failed after ${action}. The evidence did not pass the reviewed controls, so no finance figure was released.`;
      case "policy_block":
        return `Finny policy blocked ${action}. The request or workflow binding must be corrected before it can continue; no finance figure was released.`;
      case "internal_error":
        return `Finny encountered an internal error during ${action}. No finance figure was released; use the safe run trace for diagnosis.`;
    }
  }
  if (state.stage === "DELIVERY_ELIGIBLE")
    return "Finny release is blocked because verified result evidence is unavailable.";
  return `Finny release is blocked at ${state.stage}. The host has not received all required finance evidence and verification.`;
}

interface VerifiedFinnyRelease {
  records: readonly unknown[];
  sourceDigest: string;
  artifactDigest?: string;
  artifactReference?: string;
  verificationDigest: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function verifiedReleaseFromEntries(
  entries: readonly Pick<SessionEntry, "type" | "payload">[],
  state: FinnyGoldenLoopState,
  artifactReference?: string,
): VerifiedFinnyRelease | undefined {
  if (!state.sourceDigest || !state.verificationDigest) return undefined;
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "tool_result") continue;
    const payload = record(entry.payload);
    if (
      !payload ||
      payload.tool !== "finance" ||
      payload.finnyWorkflowRunId !== state.runId ||
      payload.isError === true ||
      typeof payload.result !== "string"
    )
      continue;
    let output: Record<string, unknown> | undefined;
    try {
      output = record(JSON.parse(payload.result));
    } catch {
      continue;
    }
    const evidence = record(output?.evidence);
    if (
      output?.profile !== "finny" ||
      output.harness !== "pi" ||
      output.action !== "run" ||
      output.outcome !== "delivery_eligible" ||
      output.stage !== "DELIVERY_ELIGIBLE" ||
      !evidence ||
      !Array.isArray(evidence.records) ||
      evidence.sourceDigest !== state.sourceDigest ||
      evidence.artifactDigest !== state.artifactDigest ||
      evidence.verificationDigest !== state.verificationDigest ||
      evidence.artifactReference !== artifactReference
    )
      continue;
    return {
      records: evidence.records,
      sourceDigest: state.sourceDigest,
      ...(state.artifactDigest ? { artifactDigest: state.artifactDigest } : {}),
      ...(artifactReference ? { artifactReference } : {}),
      verificationDigest: state.verificationDigest,
    };
  }
  return undefined;
}

function renderVerifiedRelease(release: VerifiedFinnyRelease): string {
  const evidence = [
    `Source evidence: ${release.sourceDigest}`,
    ...(release.artifactDigest ? [`Artifact evidence: ${release.artifactDigest}`] : []),
    ...(release.artifactReference ? [`Artifact: ${JSON.stringify(release.artifactReference)}`] : []),
    `Verification evidence: ${release.verificationDigest}`,
  ].join("\n");
  return ["Finny verified this finance result:", JSON.stringify(release.records, null, 2), evidence].join("\n\n");
}

export function withFinnyPiProfile(base: Harness, options: FinnyPiProfileOptions): Harness {
  if (base.profile.id !== "pi") throw new Error("Finny profile requires harness=pi");
  if (!options.modelId.trim()) throw new Error("Finny profile requires a pinned model");

  return {
    ...base,
    turns: {
      ...base.turns,
      async runTurn(turn: HarnessTurnInput): Promise<HarnessTurnResult> {
        if (!turn.runId) throw new Error("Finny profile requires a trusted runId");
        if (turn.runtime?.harnessId && turn.runtime.harnessId !== "pi")
          throw new Error("Finny profile requires harness=pi");
        if (turn.runtime?.modelId && turn.runtime.modelId !== options.modelId)
          throw new Error(`Finny profile requires pinned model ${options.modelId}`);

        const persisted: SessionEntry[] = [];
        const originalEmit = turn.emit;
        const knowledgeIndex = options.knowledgeIndex ? await options.knowledgeIndex : undefined;
        const selectedKnowledge = knowledgeIndex?.select(turn.input) ?? [];
        const knowledgePrompt = selectedKnowledge.length
          ? `\n\n<reviewed_finance_knowledge bundle_digest="${knowledgeIndex!.bundleDigest}">\n${JSON.stringify(
              selectedKnowledge.map((chunk) => ({
                path: chunk.path,
                sha256: chunk.sha256,
                content: chunk.content,
              })),
            )}\n</reviewed_finance_knowledge>\nUse this reviewed domain knowledge to interpret the request. It is not proof of source data, approval, verification, or delivery.`
          : "";
        const dispatched: HarnessTurnInput = {
          ...turn,
          runtime: { ...turn.runtime, harnessId: "pi", modelId: options.modelId },
          systemPrompt: `${turn.systemPrompt}${FINNY_SYSTEM_PROMPT}${knowledgePrompt}`,
          emit: async (entry) => {
            if (entry.type === "assistant" || entry.type === "text") {
              return { ...entry, seq: -1, createdAt: Date.now() } as SessionEntry;
            }
            const appended = await originalEmit(entry);
            persisted.push(appended);
            return appended;
          },
          onTextBlockStart: () => {},
          onDelta: () => {},
          onReasoningDelta: () => {},
        };

        const result = await base.turns.runTurn(dispatched);
        const workflowRunId = finnyWorkflowRunIdFromEntries(persisted);
        const checkpoint = workflowRunId ? await options.runStore.load(workflowRunId) : null;
        const state = checkpoint
          ? replayFinnyLedger(checkpoint.runId, checkpoint.ledger)
          : createFinnyGoldenLoop(turn.runId);
        const blocker = blockerFromEntries(persisted);
        const release =
          state.stage === "DELIVERY_ELIGIBLE" && checkpoint
            ? verifiedReleaseFromEntries(persisted, state, checkpoint.artifactReference)
            : undefined;
        if (!release || blocker) {
          const reply = blockedReply(state, result, blocker);
          await turn.onTextBlockStart?.("final_answer");
          turn.onDelta?.(reply);
          await originalEmit({
            type: "assistant",
            payload: {
              text: reply,
              finnyRelease: { profile: "finny", harness: "pi", stage: state.stage, outcome: "blocked" },
            },
            scopeLabel: turn.scopeLabel,
          });
          return { ...result, reply };
        }

        const reply = renderVerifiedRelease(release);
        await turn.onTextBlockStart?.("final_answer");
        turn.onDelta?.(reply);
        const outcome = turn.surfaceName === "web" ? "web_only_unattested" : "delivery_pending_attestation";
        await originalEmit({
          type: "assistant",
          payload: {
            text: reply,
            finnyRelease: { profile: "finny", harness: "pi", stage: state.stage, outcome },
          },
          scopeLabel: turn.scopeLabel,
        });
        return { ...result, reply };
      },
    },
  };
}

export function createFinnyPiHarness(options: CreateFinnyPiHarnessOptions): Harness {
  const { modelId, financeService, runStore, diagnostics, knowledgeIndex, ...piOptions } = options;
  const pi = createPiHarness({
    ...piOptions,
    modelId,
    defaultModelId: modelId,
    allowedToolNames: ["finance"],
    nativeTools: (turn, ref) => [
      createFinnyFinanceTool(turn, ref, financeService, { runStore, ...(diagnostics ? { diagnostics } : {}) }),
    ],
  });
  return withFinnyPiProfile(pi, { modelId, runStore, ...(knowledgeIndex ? { knowledgeIndex } : {}) });
}
