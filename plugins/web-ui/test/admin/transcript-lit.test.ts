import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { prepare } from "../../src/admin/transcript.ts";
const bundle = buildSync({
  entryPoints: [new URL("../../src/admin/transcript.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "transcriptUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM('<div id="header-controls"></div><div id="view-data"></div>', { runScripts: "outside-only" });
  dom.window.requestAnimationFrame = () => 0;
  dom.window.scrollTo = () => {};
  dom.window.eval(
    bundle +
      `;window.ui=transcriptUI;window.data={items:[]};window.visible={thinking:true,toolResults:true};window.services={api:async(method,path)=>({ok:true,data:path.includes('/llm?')?{requests:[]}:data}),scope:'org:test',pageSize:60,visibility:visible,current:()=>true,pageShell:()=>{},shortName:x=>x,adminErrors:async()=>[],setObserver:()=>{},entryHidden:kinds=>!visible.thinking&&kinds.includes('Reasoning'),brandSelfLabel:()=>"QM",deliveryFileBadges:()=>null};window.item=(seq,kind,extra={})=>({sessionId:'s',seq,kind,createdAt:seq,turnId:null,author:null,callId:null,text:null,tool:null,variant:null,body:{},...extra});`,
  );
  return dom;
}
const item = (seq: number, kind: string, extra: Record<string, unknown> = {}) => ({
  sessionId: "s",
  seq,
  kind,
  createdAt: seq,
  turnId: null,
  author: null,
  callId: null,
  text: null,
  tool: null,
  variant: null,
  body: {},
  ...extra,
});
test("transcript grouping pairs tool items by callId and anchors model requests on the final agent message", () => {
  const data = {
    items: [
      item(1, "UserMessage", { text: "hi" }),
      item(2, "ToolCall", { callId: "a", tool: "execute" }),
      item(3, "ToolCall", { callId: "b", tool: "read" }),
      item(4, "ToolResult", { callId: "b" }),
      item(5, "ToolResult", { callId: "a" }),
      item(6, "AgentMessage", { text: "done" }),
    ],
  };
  const result = prepare(data, [
    { turnSeq: 1, step: 2 },
    { turnSeq: 1, step: 1 },
  ]);
  assert.deepEqual(
    result.units.map((u: any) => u.kind),
    ["item", "tool", "tool", "item"],
  );
  assert.equal(result.units[1].result.seq, 5);
  assert.equal(result.units[2].result.seq, 4);
  assert.deepEqual(
    result.units[3].llmReqs.map((r: any) => r.step),
    [1, 2],
  );
});
test("items-shaped transcript renders a row per message with its text", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `data={session:{scopeId:'org:test'},items:[item(1,'UserMessage',{text:'hello there',body:{name:'Ada'}}),item(2,'ToolCall',{callId:'c',tool:'execute',body:{command:'ls'}}),item(3,'ToolResult',{callId:'c',tool:'execute',text:'ok'}),item(4,'AgentMessage',{text:'all done'})]}`,
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".empty"), null);
    assert.equal(doc.querySelector(".user-entry .entry-label")!.textContent, "Ada");
    assert.equal(doc.querySelector(".user-entry .message-body")!.textContent, "hello there");
    assert.equal(doc.querySelector(".assistant-entry .entry-label")!.textContent, "QM");
    assert.equal(doc.querySelector(".assistant-entry .message-body")!.textContent, "all done");
    assert.equal(doc.querySelectorAll(".tool-line-entry").length, 1);
    assert.match(doc.querySelector(".tool-line-entry .when")!.textContent!, /#2→#3/);
  } finally {
    dom.window.close();
  }
});
test("transcript controls filter state and preserve disclosure state without rebuilding message nodes", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      `data={items:[item(1,'UserMessage',{text:'hello'}),item(2,'Reasoning',{text:'private thought'}),item(3,'AgentMessage',{text:'reply'}),item(4,'ContextCompaction',{body:{summary:'s'}})]}`,
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    const doc = dom.window.document,
      thinking = doc.querySelector(".thinking-entry")!;
    assert.equal(thinking.querySelector("pre")!.textContent, "private thought");
    const compaction = doc.querySelector(".entry.noise")!;
    assert.equal(compaction.querySelector(".entry-label")!.textContent, "Context compaction");
    compaction.querySelector<HTMLButtonElement>(".disclosure")!.click();
    assert.equal(compaction.classList.contains("collapsed"), false);
    doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
    assert.equal(thinking.classList.contains("filtered"), true);
    assert.equal(compaction.classList.contains("collapsed"), false);
    assert.equal(doc.querySelector(".thinking-entry"), thinking);
  } finally {
    dom.window.close();
  }
});
test("header controls appear while transcript requests are pending and stale replies are ignored", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      'window.resolve=null;services.api=async()=>new Promise(r=>resolve=r);window.pending=ui.show("session",60,false,services)',
    );
    assert.equal(dom.window.document.querySelectorAll(".header-check").length, 2);
    dom.window.eval("ui.cancel();resolve({ok:true,data:{items:[]}})");
    await dom.window.eval("pending");
    assert.match(dom.window.document.getElementById("view-data")!.textContent!, /Loading/);
  } finally {
    dom.window.close();
  }
});
test("model context selection and disclosure render from state and escape captured content", () => {
  const dom = setup();
  try {
    dom.window.eval(
      `document.getElementById('view-data').append(ui.requestsPanel([{promptEnvelope:{system:'<script>bad</script>',messages:[{role:'user',content:'hello'}]}}],services,{embedded:true,page:true,selectLargest:true}))`,
    );
    const doc = dom.window.document;
    assert.equal(doc.querySelector("pre")!.textContent, "<script>bad</script>");
    assert.equal(doc.querySelectorAll("script").length, 0);
    doc.querySelector<HTMLButtonElement>(".ctx-messages")!.click();
    assert.equal(doc.querySelector("pre")!.textContent, "[user]\nhello");
    assert.equal(doc.querySelector(".ctx-messages")!.getAttribute("aria-pressed"), "true");
  } finally {
    dom.window.close();
  }
});
test("deep-link back navigation uses the fetched session scope", async () => {
  const dom = setup();
  try {
    dom.window.history.replaceState({ deepLink: true }, "");
    dom.window.eval(
      'window.shell=null;window.destination=null;services.pageShell=value=>shell=value;services.go=value=>destination=value;data={session:{scopeId:"channel:actual"},items:[]}',
    );
    await dom.window.eval('ui.show("session",60,false,services)');
    dom.window.eval("shell.back.onClick()");
    assert.equal(dom.window.eval("destination.scope"), "channel:actual");
    assert.equal(dom.window.eval("destination.session"), null);
  } finally {
    dom.window.close();
  }
});
