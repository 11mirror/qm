import { createPostgresToolOutputStore } from "../sessions/tool-output.ts";
import { createAclStore } from "../acl/acl-store.ts";
import { createPostgresGrantStore } from "../acl/postgres-grant-store.ts";
import { createPostgresRateLimiter, RATE_LIMIT } from "../ratelimit/postgres-rate-limiter.ts";
import { createPostgresBudgetTracker } from "../ratelimit/postgres-budget.ts";
import { createResolutionService } from "../resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../workspace/workspace-store.ts";
import {
  type BlobTransferStore,
  createS3BlobTransferStore,
  createLocalBlobTransferStore,
} from "../persistence/blob-transfer.ts";
import { join } from "node:path";
import {
  type DurableByteStore,
  createS3DurableByteStore,
  createLocalDurableByteStore,
} from "../files/durable-byte-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../files/postgres-file-artifact-store.ts";
import { createDirectFileUploads } from "../files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "../files/file-upload-store.ts";
import { createMcpServerStore, type McpServer } from "../mcp/mcp-server-store.ts";
import { withErrorReporting } from "../admin/error-log.ts";
import { createPostgresErrorLog } from "../admin/postgres-error-log.ts";
import type { StoresModule } from "./stores.ts";
import type { Config } from "../config.ts";

export function buildFiles(
  w: Pick<StoresModule, "managesArtifactHome" | "configStore" | "artifactMap" | "pgArtifactMap"> & {
    databaseUrl: string;
    config: Config;
  },
) {
  const { databaseUrl, managesArtifactHome, config, configStore, artifactMap, pgArtifactMap } = w;

  const acl = createAclStore(createPostgresGrantStore(databaseUrl), {
    manages: (principalId, scopeId, authoredBy) => managesArtifactHome(scopeId, authoredBy ?? "", principalId),
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const rateLimiter = createPostgresRateLimiter(databaseUrl, RATE_LIMIT);
  const budgetOpts = {
    ...(config.budgetUsdPerWindow !== undefined ? { limitUsd: config.budgetUsdPerWindow } : {}),
    ...(config.orgBudgetUsdPerWindow !== undefined ? { orgLimitUsd: config.orgBudgetUsdPerWindow } : {}),
  };
  const budget =
    config.budgetUsdPerWindow !== undefined || config.orgBudgetUsdPerWindow !== undefined
      ? createPostgresBudgetTracker(databaseUrl, budgetOpts)
      : undefined;
  const resolution = createResolutionService(config.orgId, configStore, acl);
  const workspace = createLocalWorkspaceStore(config.dataDir);
  const blobTransfer: BlobTransferStore = config.s3Bucket
    ? createS3BlobTransferStore({
        bucket: config.s3Bucket,
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
      })
    : createLocalBlobTransferStore(join(config.dataDir, "transfer"));
  const s3Bytes = (bucket: string, prefix: string): DurableByteStore =>
    createS3DurableByteStore({
      bucket,
      ...(config.s3Region ? { region: config.s3Region } : {}),
      prefix: `${config.s3Prefix ?? ""}${prefix}`,
    });
  // S3 under `prefix` when a bucket is configured, else local disk under dataDir/localDir.
  const byteStore = (prefix: string, localDir: string): DurableByteStore =>
    config.s3Bucket ? s3Bytes(config.s3Bucket, prefix) : createLocalDurableByteStore(join(config.dataDir, localDir));
  const fileBytes = byteStore("", "docstore");
  const files: FileArtifactStore = createPostgresFileArtifactStore(databaseUrl, fileBytes);
  const fileUploads = config.s3Bucket
    ? createDirectFileUploads({
        bucket: config.s3Bucket,
        ...(config.s3Region ? { region: config.s3Region } : {}),
        ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        store: createPostgresFileUploadStore(databaseUrl),
        files,
      })
    : undefined;
  const mcpServers = createMcpServerStore(artifactMap<McpServer>("mcp_servers"));
  const errors = withErrorReporting(createPostgresErrorLog(databaseUrl));
  const toolOutput = createPostgresToolOutputStore({
    pool: pgArtifactMap.pool,
    bytesFor: (prefix) => byteStore(prefix, prefix),
  });
  return {
    toolOutput,
    errors,
    blobTransfer,
    workspace,
    mcpServers,
    byteStore,
    s3Bytes,
    acl,
    resolution,
    files,
    rateLimiter,
    budget,
    fileUploads,
  };
}

export type FilesModule = ReturnType<typeof buildFiles>;
