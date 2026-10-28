import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials" | "oauth-user";

export type McpApprovalPolicy = "annotations" | "all" | "none";

export interface McpServer {
  id: string;
  name: string;
  about?: string;
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
    about?: string;
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
  columns: cols(`about text, name text!, url text!, auth text!, credentialScope text, credentialHost text,
    credentialAccountType text, bearerToken text, clientId text, clientSecret text,
    oauthAuthorizeUrl text, oauthTokenUrl text, oauthScopes text[], tools jsonb, approval text,
    catalog boolean, attestActor boolean, readOnly boolean!, enabled boolean!, updatedAt bigint!,
    updatedBy text!`),
};

const { about: _about, ...oldColumns } = MCP_SERVERS.columns;
const MCP_SERVERS_MIGRATION = mapToTableMigration("mcp/servers/0001-typed", { ...MCP_SERVERS, columns: oldColumns });
const MCP_ABOUT_MIGRATION = {
  id: "mcp/servers/0002-about",
  statements: ["ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS about text"],
};

export function createMcpServerStore(databaseUrl: string): McpServerStore {
  const table = typedTable<McpServer>(
    createPgPool(databaseUrl, [MCP_SERVERS_MIGRATION, MCP_ABOUT_MIGRATION]),
    MCP_SERVERS,
  );
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    list: table.all,
    get: table.get,
    put: async (server) => {
      await table.put(server.id, server);
      emit();
    },
    delete: async (id) => {
      await table.delete(id);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
