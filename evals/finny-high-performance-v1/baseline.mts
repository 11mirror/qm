export interface FinnyBaselineInput {
  queryAt: number;
  artifactReadyAt: number;
  certifiedDeliveredAt: number;
  sessions: {
    parent: string;
    producer: string;
    auditor: string;
  };
  runs: Array<{
    id: string;
    role?: Role;
    sessionId: string;
    startedAt: number | null;
    finishedAt: number | null;
  }>;
  llmRequests: Array<{
    id: string;
    role?: Role;
    sessionId: string;
    turnSeq: number | null;
    step: number;
    usage: { totalTokens: number } | null;
  }>;
}

type Role = keyof FinnyBaselineInput["sessions"];

function roleTokens(
  input: FinnyBaselineInput,
  role: Role,
): { value: number | null; missing: string[]; missingRole: boolean } {
  const sessionId = input.sessions[role];
  const requests = input.llmRequests.filter(
    (request) => request.role === role || (request.role === undefined && request.sessionId === sessionId),
  );
  if (requests.length === 0) return { value: null, missing: [], missingRole: true };
  const missing = requests
    .filter((request) => request.usage === null || !Number.isFinite(request.usage.totalTokens))
    .map((request) => request.id);
  if (missing.length) return { value: null, missing, missingRole: false };
  return {
    value: requests.reduce((sum, request) => sum + request.usage!.totalTokens, 0),
    missing,
    missingRole: false,
  };
}

export function analyzeFinnyBaseline(input: FinnyBaselineInput) {
  const producerRuns = input.runs.filter(
    (run) => run.role === "producer" || (run.role === undefined && run.sessionId === input.sessions.producer),
  );
  const auditorRuns = input.runs.filter(
    (run) => run.role === "auditor" || (run.role === undefined && run.sessionId === input.sessions.auditor),
  );
  const auditorRunsBeforeArtifact = auditorRuns
    .filter((run) => run.startedAt !== null && run.startedAt < input.artifactReadyAt)
    .map((run) => run.id);
  const parent = roleTokens(input, "parent");
  const producer = roleTokens(input, "producer");
  const auditor = roleTokens(input, "auditor");
  const missingUsageRequestIds = [...parent.missing, ...producer.missing, ...auditor.missing];
  const missingUsageRoles = (Object.keys(input.sessions) as Role[]).filter((role) => {
    if (role === "parent") return parent.missingRole;
    if (role === "producer") return producer.missingRole;
    return auditor.missingRole;
  });
  const complete = missingUsageRequestIds.length === 0 && missingUsageRoles.length === 0;
  const queryToCertifiedDeliveryMs = input.certifiedDeliveredAt - input.queryAt;
  const total = complete ? parent.value! + producer.value! + auditor.value! : null;

  return {
    turns: {
      producerRunCount: producerRuns.length,
      auditorRunCount: auditorRuns.length,
      auditorRunsBeforeArtifact,
    },
    queryToCertifiedDeliveryMs,
    tokens: {
      complete,
      parent: parent.value,
      producer: producer.value,
      auditor: auditor.value,
      total,
      missingUsageRequestIds,
      missingUsageRoles,
    },
    phase1GatePassed:
      producerRuns.length === 1 &&
      auditorRuns.length === 1 &&
      auditorRunsBeforeArtifact.length === 0 &&
      queryToCertifiedDeliveryMs >= 0 &&
      complete,
  };
}
