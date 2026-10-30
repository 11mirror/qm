import type { ServiceCredentialReader } from "../credentials/keychain.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { ScopeId } from "../types.ts";
import { createBrokeredFinanceService, type AtomicFetchAdapter } from "./credential-brokered-finance-service.ts";
import { createEvidenceBackedFinanceService, type EvidenceBackedRunStore } from "./evidence-backed-finance-service.ts";
import type { FinanceService } from "./finance.ts";
import type { FinanceDiagnosticSink } from "./finance-failure.ts";
import { createUnavailableFinanceService } from "./unavailable-finance-service.ts";

interface DefaultFinnyFinanceServiceOptions {
  credentialReader: ServiceCredentialReader;
  orgScopeId: ScopeId;
  files: FileArtifactStore;
  evidenceBytes: DurableByteStore;
  runStore?: EvidenceBackedRunStore;
  atomicFetch: AtomicFetchAdapter;
  diagnostics?: FinanceDiagnosticSink;
}

export function createDefaultFinnyFinanceService(options: DefaultFinnyFinanceServiceOptions): FinanceService {
  const brokered = createBrokeredFinanceService({
    delegate: createUnavailableFinanceService(),
    credentialReader: options.credentialReader,
    orgScopeId: options.orgScopeId,
    credentialSlugs: {
      netsuite: "finny-netsuite",
    },
    atomicFetch: options.atomicFetch,
    diagnostics: options.diagnostics,
  });
  return createEvidenceBackedFinanceService({
    delegate: brokered,
    files: options.files,
    evidenceBytes: options.evidenceBytes,
    ...(options.runStore ? { runStore: options.runStore } : {}),
  });
}
