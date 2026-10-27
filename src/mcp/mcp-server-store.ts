// Registry of admin-configured MCP servers.
//
// Admin-only by design: registering a server points every scope's agents at
// an outbound HTTP endpoint, so end users must not be able to add one (SSRF
// and exfiltration surface). Secrets live in the record like other stored
// connector credentials — reachable only through core, never injected into sandboxes.

import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";

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
  columns: cols(`name text!, url text!, auth text!, credentialScope text, credentialHost text,
    credentialAccountType text, bearerToken text, clientId text, clientSecret text,
    oauthAuthorizeUrl text, oauthTokenUrl text, oauthScopes text[], tools jsonb, approval text,
    catalog boolean, attestActor boolean, readOnly boolean!, enabled boolean!, updatedAt bigint!,
    updatedBy text!`),
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
