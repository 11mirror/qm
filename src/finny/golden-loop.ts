import { createHash } from "node:crypto";
import type { FinnyVerificationPolicy } from "./accounting-validator.ts";
export { FINANCE_RESOURCE_NAME } from "./finance.ts";

export type FinnyDigest = `sha256:${string}`;

export const FINNY_STAGES = [
  "CLARIFY",
  "PREFLIGHT",
  "PLAN_APPROVED",
  "SOURCE",
  "ARTIFACT_REQUIRED",
  "ARTIFACT_OPTIONAL",
  "VERIFIED",
  "DELIVERY_ELIGIBLE",
] as const;

export type FinnyStage = (typeof FINNY_STAGES)[number];

export const FINNY_EVENT_KINDS = [
  "clarify_completed",
  "preflight_completed",
  "plan_approved",
  "plan_exempted",
  "source_collected",
  "artifact_classified",
  "artifact_produced",
  "verification_passed",
  "delivery_authorized",
] as const;

export type FinnyEventKind = (typeof FINNY_EVENT_KINDS)[number];

export function isFinnyStage(value: string): value is FinnyStage {
  return FINNY_STAGES.some((stage) => stage === value);
}

export function isFinnyEventKind(value: string): value is FinnyEventKind {
  return FINNY_EVENT_KINDS.some((kind) => kind === value);
}

interface FinnyHostEventBase {
  authority: "qm-host";
  eventId: string;
  occurredAt: string;
}

export type FinnyHostEvent =
  | (FinnyHostEventBase & {
      kind: "clarify_completed";
      evidenceDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "preflight_completed";
      preflightDigest: FinnyDigest;
      planDigest: FinnyDigest;
      queryDigest: FinnyDigest;
      verificationPolicy: FinnyVerificationPolicy;
      verificationPolicyDigest: FinnyDigest;
      approvalRequired?: boolean;
      approvalPolicyDigest?: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "plan_approved";
      planDigest: FinnyDigest;
      approvalDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "plan_exempted";
      planDigest: FinnyDigest;
      approvalPolicyDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "source_collected";
      sourceDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "artifact_classified";
      requirement: "required" | "optional";
      policyDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "artifact_produced";
      artifactDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "verification_passed";
      verificationDigest: FinnyDigest;
    })
  | (FinnyHostEventBase & {
      kind: "delivery_authorized";
      deliveryDigest: FinnyDigest;
    });

export const FINNY_EVIDENCE_ROLES = [
  "clarification",
  "preflight",
  "plan",
  "query",
  "verification_policy",
  "approval",
  "approval_policy",
  "source",
  "artifact_policy",
  "artifact",
  "verification",
  "delivery",
] as const;

export type FinnyEvidenceRole = (typeof FINNY_EVIDENCE_ROLES)[number];

export function isFinnyEvidenceRole(value: string): value is FinnyEvidenceRole {
  return FINNY_EVIDENCE_ROLES.some((role) => role === value);
}

export interface FinnyLedgerEvidence {
  role: FinnyEvidenceRole;
  digest: FinnyDigest;
}

export interface FinnyLedgerMetadata {
  schema: "finny.golden_loop.v1";
  runId: string;
  profile: "finny";
  harness: "pi";
  eventId: string;
  eventKind: FinnyHostEvent["kind"];
  occurredAt: string;
  fromStage: FinnyStage;
  toStage: FinnyStage;
  evidence: readonly FinnyLedgerEvidence[];
  approvalRequired?: boolean;
  artifactRequirement?: "required" | "optional";
  verificationPolicy?: FinnyVerificationPolicy;
}

export interface FinnyGoldenLoopState {
  runId: string;
  profile: "finny";
  harness: "pi";
  stage: FinnyStage;
  clarificationDigest?: FinnyDigest;
  preflightDigest?: FinnyDigest;
  planDigest?: FinnyDigest;
  queryDigest?: FinnyDigest;
  verificationPolicy?: FinnyVerificationPolicy;
  verificationPolicyDigest?: FinnyDigest;
  approvalDigest?: FinnyDigest;
  approvalRequired?: boolean;
  approvalPolicyDigest?: FinnyDigest;
  sourceDigest?: FinnyDigest;
  artifactRequirement?: "required" | "optional";
  artifactPolicyDigest?: FinnyDigest;
  artifactDigest?: FinnyDigest;
  verificationDigest?: FinnyDigest;
  deliveryDigest?: FinnyDigest;
  ledger: readonly FinnyLedgerMetadata[];
}

export class FinnyGoldenLoopError extends Error {
  readonly code: "invalid_event" | "invalid_transition" | "replayed_event" | "evidence_mismatch";

  constructor(code: FinnyGoldenLoopError["code"], message: string) {
    super(message);
    this.name = "FinnyGoldenLoopError";
    this.code = code;
  }
}

export function digestFinnyEvidence(value: string | Uint8Array): FinnyDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createFinnyGoldenLoop(runId: string): FinnyGoldenLoopState {
  if (!runId) throw new FinnyGoldenLoopError("invalid_event", "runId is required");
  return {
    runId,
    profile: "finny",
    harness: "pi",
    stage: "CLARIFY",
    ledger: [],
  };
}

export function applyFinnyHostEvent(state: FinnyGoldenLoopState, candidate: unknown): FinnyGoldenLoopState {
  const event = parseHostEvent(candidate);
  if (state.ledger.some((entry) => entry.eventId === event.eventId)) {
    throw new FinnyGoldenLoopError("replayed_event", `Replayed event ${event.eventId}`);
  }

  const next = transition(state, event);
  const metadata = metadataFor(state, next, event);
  return { ...next, ledger: [...state.ledger, metadata] };
}

export function replayFinnyLedger(runId: string, ledger: readonly FinnyLedgerMetadata[]): FinnyGoldenLoopState {
  let state = createFinnyGoldenLoop(runId);
  const eventIds = new Set<string>();
  for (const metadata of ledger) {
    if (eventIds.has(metadata.eventId)) {
      throw new FinnyGoldenLoopError("replayed_event", `Replayed event ${metadata.eventId}`);
    }
    eventIds.add(metadata.eventId);
    if (metadata.runId !== runId || metadata.profile !== "finny" || metadata.harness !== "pi") {
      throw new FinnyGoldenLoopError("invalid_event", "Ledger identity does not match Finny Pi run");
    }
    if (metadata.fromStage !== state.stage) {
      throw new FinnyGoldenLoopError("invalid_transition", "Ledger stage does not match replay state");
    }
    state = applyFinnyHostEvent(state, eventFromMetadata(metadata));
    const actual = state.ledger.at(-1);
    if (actual?.toStage !== metadata.toStage) {
      throw new FinnyGoldenLoopError("invalid_transition", "Ledger target stage does not match replay");
    }
  }
  return state;
}

function transition(state: FinnyGoldenLoopState, event: FinnyHostEvent): FinnyGoldenLoopState {
  switch (event.kind) {
    case "clarify_completed":
      requireStage(state, event, "CLARIFY");
      return { ...state, stage: "PREFLIGHT", clarificationDigest: event.evidenceDigest };
    case "preflight_completed":
      requireStage(state, event, "PREFLIGHT");
      if (state.preflightDigest) invalidTransition(state, event);
      if (event.approvalRequired === false && !event.approvalPolicyDigest) {
        throw new FinnyGoldenLoopError("invalid_event", "Approval exemption requires a policy digest");
      }
      return {
        ...state,
        preflightDigest: event.preflightDigest,
        planDigest: event.planDigest,
        queryDigest: event.queryDigest,
        verificationPolicy: event.verificationPolicy,
        verificationPolicyDigest: event.verificationPolicyDigest,
        approvalRequired: event.approvalRequired ?? true,
        ...(event.approvalPolicyDigest ? { approvalPolicyDigest: event.approvalPolicyDigest } : {}),
      };
    case "plan_approved":
      requireStage(state, event, "PREFLIGHT");
      if (!state.planDigest || state.planDigest !== event.planDigest) {
        throw new FinnyGoldenLoopError(
          "evidence_mismatch",
          "Approval plan digest does not match the preflight plan digest",
        );
      }
      return { ...state, stage: "PLAN_APPROVED", approvalDigest: event.approvalDigest };
    case "plan_exempted":
      requireStage(state, event, "PREFLIGHT");
      if (
        state.approvalRequired !== false ||
        !state.planDigest ||
        state.planDigest !== event.planDigest ||
        !state.approvalPolicyDigest ||
        state.approvalPolicyDigest !== event.approvalPolicyDigest
      ) {
        throw new FinnyGoldenLoopError("evidence_mismatch", "Plan exemption does not match host preflight policy");
      }
      return { ...state, stage: "PLAN_APPROVED" };
    case "source_collected":
      requireStage(state, event, "PLAN_APPROVED");
      return { ...state, stage: "SOURCE", sourceDigest: event.sourceDigest };
    case "artifact_classified":
      requireStage(state, event, "SOURCE");
      return {
        ...state,
        stage: event.requirement === "required" ? "ARTIFACT_REQUIRED" : "ARTIFACT_OPTIONAL",
        artifactRequirement: event.requirement,
        artifactPolicyDigest: event.policyDigest,
      };
    case "artifact_produced":
      requireStage(state, event, "ARTIFACT_REQUIRED");
      if (state.artifactDigest) invalidTransition(state, event);
      return { ...state, artifactDigest: event.artifactDigest };
    case "verification_passed":
      requireOneStage(state, event, "ARTIFACT_REQUIRED", "ARTIFACT_OPTIONAL");
      if (state.stage === "ARTIFACT_REQUIRED" && !state.artifactDigest) {
        throw new FinnyGoldenLoopError("invalid_transition", "A required artifact must exist before verification");
      }
      return { ...state, stage: "VERIFIED", verificationDigest: event.verificationDigest };
    case "delivery_authorized":
      requireStage(state, event, "VERIFIED");
      return { ...state, stage: "DELIVERY_ELIGIBLE", deliveryDigest: event.deliveryDigest };
  }
}

function parseHostEvent(candidate: unknown): FinnyHostEvent {
  if (!candidate || typeof candidate !== "object") {
    throw new FinnyGoldenLoopError("invalid_event", "Host event must be an object");
  }
  const record = candidate as Record<string, unknown>;
  if (record.authority !== "qm-host") {
    throw new FinnyGoldenLoopError("invalid_event", "Finny transitions require host authority");
  }
  requireText(record.eventId, "eventId");
  requireText(record.occurredAt, "occurredAt");
  requireText(record.kind, "kind");
  for (const digest of digestsFromRecord(record)) requireDigest(digest);

  switch (record.kind) {
    case "clarify_completed":
      requireDigest(record.evidenceDigest);
      break;
    case "preflight_completed":
      requireDigest(record.preflightDigest);
      requireDigest(record.planDigest);
      requireDigest(record.queryDigest);
      requireVerificationPolicy(record.verificationPolicy);
      requireDigest(record.verificationPolicyDigest);
      if (
        record.verificationPolicyDigest !==
        digestFinnyEvidence(`finny-verification-policy:v1:${record.verificationPolicy}`)
      ) {
        throw new FinnyGoldenLoopError("evidence_mismatch", "Verification policy digest does not match policy");
      }
      if (record.approvalRequired !== undefined && typeof record.approvalRequired !== "boolean") {
        throw new FinnyGoldenLoopError("invalid_event", "approvalRequired must be boolean");
      }
      if (record.approvalRequired === false) requireDigest(record.approvalPolicyDigest);
      break;
    case "plan_approved":
      requireDigest(record.planDigest);
      requireDigest(record.approvalDigest);
      break;
    case "plan_exempted":
      requireDigest(record.planDigest);
      requireDigest(record.approvalPolicyDigest);
      break;
    case "source_collected":
      requireDigest(record.sourceDigest);
      break;
    case "artifact_classified":
      if (record.requirement !== "required" && record.requirement !== "optional") {
        throw new FinnyGoldenLoopError("invalid_event", "Invalid artifact requirement");
      }
      requireDigest(record.policyDigest);
      break;
    case "artifact_produced":
      requireDigest(record.artifactDigest);
      break;
    case "verification_passed":
      requireDigest(record.verificationDigest);
      break;
    case "delivery_authorized":
      requireDigest(record.deliveryDigest);
      break;
    default:
      throw new FinnyGoldenLoopError("invalid_event", `Unknown host event ${record.kind}`);
  }
  return candidate as FinnyHostEvent;
}

function requireStage(state: FinnyGoldenLoopState, event: FinnyHostEvent, expected: FinnyStage): void {
  if (state.stage !== expected) invalidTransition(state, event);
}

function requireOneStage(
  state: FinnyGoldenLoopState,
  event: FinnyHostEvent,
  first: FinnyStage,
  second: FinnyStage,
): void {
  if (state.stage !== first && state.stage !== second) invalidTransition(state, event);
}

function invalidTransition(state: FinnyGoldenLoopState, event: FinnyHostEvent): never {
  throw new FinnyGoldenLoopError("invalid_transition", `Invalid transition ${event.kind} from ${state.stage}`);
}

function metadataFor(
  previous: FinnyGoldenLoopState,
  next: FinnyGoldenLoopState,
  event: FinnyHostEvent,
): FinnyLedgerMetadata {
  return {
    schema: "finny.golden_loop.v1",
    runId: previous.runId,
    profile: "finny",
    harness: "pi",
    eventId: event.eventId,
    eventKind: event.kind,
    occurredAt: event.occurredAt,
    fromStage: previous.stage,
    toStage: next.stage,
    evidence: evidenceFor(event),
    ...(event.kind === "preflight_completed" ? { approvalRequired: event.approvalRequired ?? true } : {}),
    ...(event.kind === "preflight_completed" ? { verificationPolicy: event.verificationPolicy } : {}),
    ...(event.kind === "artifact_classified" ? { artifactRequirement: event.requirement } : {}),
  };
}

function evidenceFor(event: FinnyHostEvent): readonly FinnyLedgerEvidence[] {
  switch (event.kind) {
    case "clarify_completed":
      return [{ role: "clarification", digest: event.evidenceDigest }];
    case "preflight_completed":
      return [
        { role: "preflight", digest: event.preflightDigest },
        { role: "plan", digest: event.planDigest },
        { role: "query", digest: event.queryDigest },
        { role: "verification_policy", digest: event.verificationPolicyDigest },
        ...(event.approvalPolicyDigest
          ? [{ role: "approval_policy" as const, digest: event.approvalPolicyDigest }]
          : []),
      ];
    case "plan_approved":
      return [
        { role: "plan", digest: event.planDigest },
        { role: "approval", digest: event.approvalDigest },
      ];
    case "plan_exempted":
      return [
        { role: "plan", digest: event.planDigest },
        { role: "approval_policy", digest: event.approvalPolicyDigest },
      ];
    case "source_collected":
      return [{ role: "source", digest: event.sourceDigest }];
    case "artifact_classified":
      return [{ role: "artifact_policy", digest: event.policyDigest }];
    case "artifact_produced":
      return [{ role: "artifact", digest: event.artifactDigest }];
    case "verification_passed":
      return [{ role: "verification", digest: event.verificationDigest }];
    case "delivery_authorized":
      return [{ role: "delivery", digest: event.deliveryDigest }];
  }
}

function eventFromMetadata(metadata: FinnyLedgerMetadata): FinnyHostEvent {
  const common = {
    authority: "qm-host" as const,
    eventId: metadata.eventId,
    occurredAt: metadata.occurredAt,
  };
  switch (metadata.eventKind) {
    case "clarify_completed":
      return { ...common, kind: metadata.eventKind, evidenceDigest: evidence(metadata, "clarification") };
    case "preflight_completed":
      return {
        ...common,
        kind: metadata.eventKind,
        preflightDigest: evidence(metadata, "preflight"),
        planDigest: evidence(metadata, "plan"),
        queryDigest: evidence(metadata, "query"),
        verificationPolicy: requiredMetadataPolicy(metadata.verificationPolicy),
        verificationPolicyDigest: evidence(metadata, "verification_policy"),
        approvalRequired: metadata.approvalRequired ?? true,
        ...(metadata.approvalRequired === false ? { approvalPolicyDigest: evidence(metadata, "approval_policy") } : {}),
      };
    case "plan_approved":
      return {
        ...common,
        kind: metadata.eventKind,
        planDigest: evidence(metadata, "plan"),
        approvalDigest: evidence(metadata, "approval"),
      };
    case "plan_exempted":
      return {
        ...common,
        kind: metadata.eventKind,
        planDigest: evidence(metadata, "plan"),
        approvalPolicyDigest: evidence(metadata, "approval_policy"),
      };
    case "source_collected":
      return { ...common, kind: metadata.eventKind, sourceDigest: evidence(metadata, "source") };
    case "artifact_classified":
      if (!metadata.artifactRequirement) {
        throw new FinnyGoldenLoopError("invalid_event", "Artifact requirement is missing");
      }
      return {
        ...common,
        kind: metadata.eventKind,
        requirement: metadata.artifactRequirement,
        policyDigest: evidence(metadata, "artifact_policy"),
      };
    case "artifact_produced":
      return { ...common, kind: metadata.eventKind, artifactDigest: evidence(metadata, "artifact") };
    case "verification_passed":
      return {
        ...common,
        kind: metadata.eventKind,
        verificationDigest: evidence(metadata, "verification"),
      };
    case "delivery_authorized":
      return { ...common, kind: metadata.eventKind, deliveryDigest: evidence(metadata, "delivery") };
  }
}

function evidence(metadata: FinnyLedgerMetadata, role: FinnyEvidenceRole): FinnyDigest {
  const value = metadata.evidence.find((item) => item.role === role)?.digest;
  if (!value) throw new FinnyGoldenLoopError("invalid_event", `Missing ${role} evidence`);
  return value;
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FinnyGoldenLoopError("invalid_event", `${field} is required`);
  }
}

function requireDigest(value: unknown): asserts value is FinnyDigest {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    value.length !== 71 ||
    [...value.slice(7)].some((character) => !"0123456789abcdef".includes(character))
  ) {
    throw new FinnyGoldenLoopError("invalid_event", "Evidence must be a sha256 digest");
  }
}

function requireVerificationPolicy(value: unknown): asserts value is FinnyVerificationPolicy {
  if (
    value !== "repeatable_read" &&
    value !== "single_numeric_total" &&
    value !== "balanced_debits_credits" &&
    value !== "balance_sheet_equation"
  ) {
    throw new FinnyGoldenLoopError("invalid_event", "Verification policy is invalid");
  }
}

function requiredMetadataPolicy(value: unknown): FinnyVerificationPolicy {
  requireVerificationPolicy(value);
  return value;
}

function digestsFromRecord(record: Record<string, unknown>): unknown[] {
  return Object.entries(record)
    .filter(([key]) => key.endsWith("Digest"))
    .map(([, value]) => value);
}
