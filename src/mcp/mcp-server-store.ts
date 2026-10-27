// Registry of admin-configured MCP servers.
//
// Admin-only by design: registering a server points every scope's agents at
// an outbound HTTP endpoint, so end users must not be able to add one (SSRF
// and exfiltration surface). Secrets live in the record like other stored
// connector credentials — reachable only through core, never injected into sandboxes.

import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials" | "oauth-user";

export type McpApprovalPolicy = "annotations" | "all" | "none";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string[];
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }>;
  approval?: McpApprovalPolicy;
  catalog?: boolean;
  attestActor?: boolean;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

const MCP_SERVERS: TableSpec = {
  table: "mcp_servers",
  key: "id",
  keyIsField: true,
  columns: {
    name: { type: "text", required: true },
    url: { type: "text", required: true },
    auth: { type: "text", required: true },
    credentialScope: { type: "text" },
    credentialHost: { type: "text" },
    credentialAccountType: { type: "text" },
    bearerToken: { type: "text" },
    clientId: { type: "text" },
    clientSecret: { type: "text" },
    oauthAuthorizeUrl: { type: "text" },
    oauthTokenUrl: { type: "text" },
    oauthScopes: { type: "text[]" },
    tools: { type: "jsonb" },
    approval: { type: "text" },
    catalog: { type: "boolean" },
    attestActor: { type: "boolean" },
    readOnly: { type: "boolean", required: true },
    enabled: { type: "boolean", required: true },
    updatedAt: { type: "bigint", required: true },
    updatedBy: { type: "text", required: true },
  },
};

export const MCP_SERVERS_MIGRATION = mapToTableMigration("mcp/servers/0001-typed", MCP_SERVERS);

const codec = tableCodec<McpServer>(MCP_SERVERS);

export function createMcpServerStore(databaseUrl: string): McpServerStore {
  const { q } = createPgPool(databaseUrl, [MCP_SERVERS_MIGRATION]);
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    list: async () => codec.rows(await q(`SELECT ${codec.columns} FROM mcp_servers ORDER BY id`)),
    get: async (id) => codec.rows(await q(`SELECT ${codec.columns} FROM mcp_servers WHERE id = $1`, [id]))[0] ?? null,
    put: async (server) => {
      await q(
        `INSERT INTO mcp_servers (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${codec.updates}`,
        codec.values(server.id, server),
      );
      emit();
    },
    delete: async (id) => {
      await q(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
