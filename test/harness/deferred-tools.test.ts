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
  assert.match(searchMcpTools(tools, "find_6").split("\n")[0]!, /find_6/);
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
  assert.match(note, /CRM \[crm\] \(2 tools\)/);
  assert.match(note, /passing the server id in brackets and the tool name/);
  assert.equal(connectorToolsNote([]), "");
  assert.match(connectorToolsNote([{ ...tools[0]!, signIn: true }]), /find_0/);
});

test("catalog connectors remain direct and never enter the deferred note", () => {
  const catalog = { ...tools[0]!, catalog: true as const };
  assert.deepEqual(deferredMcpTools([catalog, tools[1]!], false), [tools[1]!]);
});

test("connector inventories fairly budget short tool lines and retain every server", () => {
  const many = ["alpha", "beta", "gamma"].flatMap((server) =>
    Array.from({ length: 100 }, (_, i) => ({
      ...tools[0]!,
      serverId: server,
      serverName: server,
      remoteName: `long_${i}`,
      description: "x".repeat(200),
    })).concat([{ ...tools[0]!, serverId: server, serverName: server, remoteName: "short", description: "Short" }]),
  );
  const note = connectorToolsNote(many);
  for (const server of ["alpha", "beta", "gamma"]) assert.match(note, new RegExp(`\\[${server}\\]`));
  assert.equal(note.split("  - short // Short").length - 1, 3);
  assert.match(note, /This list is partial/);
  assert.ok(note.length < 9_000);
});
