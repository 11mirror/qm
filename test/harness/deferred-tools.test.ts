import assert from "node:assert/strict";
import test from "node:test";
import { connectorToolsNote, deferredMcpTools, searchMcpTools } from "../../src/harness/deferred-tools.ts";
import type { McpToolDescriptor } from "../../src/mcp/mcp-tool-service.ts";

const tools: McpToolDescriptor[] = Array.from({ length: 7 }, (_, i) => ({
  name: `crm_find_${i}`,
  serverId: "crm",
  serverName: "CRM",
  serverAbout: "Search company records. Keep the full description.",
  remoteName: `find_${i}`,
  description: `Search records ${i}. Full second sentence.`,
  inputSchema: { type: "object" },
  readOnly: i < 2,
  needsApproval: i >= 2,
}));

test("connector search ranks exact names, returns full schemas and caps broad matches", () => {
  assert.match(searchMcpTools(tools, "crm_find_6").split("\n")[0]!, /crm_find_6/);
  assert.match(searchMcpTools(tools, "records"), /2 more match/);
  assert.match(searchMcpTools(tools, "records"), /Full second sentence/);
  assert.match(searchMcpTools(tools, "records"), /"parameters":\{"type":"object"\}/);
  assert.match(searchMcpTools(tools, "nonexistent"), /No connector tools match/);
  assert.equal(searchMcpTools(tools, "*").split("\n").length, 7);
});

test("read-only connector notes and searches contain only allowed tools", () => {
  const allowed = deferredMcpTools(tools, true);
  assert.equal(allowed.length, 2);
  const note = connectorToolsNote(allowed);
  assert.match(note, /CRM \(search company records\): 2 tools/);
  assert.match(note, /tool_search finds a tool, mcp_call runs it/);
  assert.equal(connectorToolsNote([]), "");
  assert.match(connectorToolsNote([{ ...tools[0]!, signIn: true }]), /not connected; mcp_call crm_find_0 to connect/);
});
