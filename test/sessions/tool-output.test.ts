import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import {
  cutToolOutput,
  cutUnparkedToolOutput,
  parkIfOverCap,
  DEFAULT_INLINE_TOKENS,
  inlineTokensFrom,
  parkedOutputKey,
  type ToolOutputStore,
} from "../../src/sessions/tool-output.ts";
import { createToolContext } from "../../src/tools/tool-context.ts";
import { scopeId } from "../../src/types.ts";

test("the inline cap setting: unset means 4096 tokens, 0 means off, junk falls back", () => {
  assert.equal(inlineTokensFrom(undefined), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(null), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom(0), 0);
  assert.equal(inlineTokensFrom("2048"), 2048);
  assert.equal(inlineTokensFrom(-1), DEFAULT_INLINE_TOKENS);
  assert.equal(inlineTokensFrom({}), DEFAULT_INLINE_TOKENS);
});

test("cutToolOutput keeps text within the budget untouched and halves the rest between head and tail", () => {
  assert.equal(cutToolOutput("short", 10, "c1"), null);
  assert.equal(cutToolOutput("x".repeat(1_000), 0, "c1"), null);
  const text = "H".repeat(500) + "T".repeat(500);
  const cut = cutToolOutput(text, 50, "c1")!;
  assert.equal(cut.shownChars, 200);
  assert.ok(cut.text.startsWith("H".repeat(100)));
  assert.ok(cut.text.endsWith("T".repeat(100)));
  const path = /tool-output\/\S+(?=;)/.exec(cut.text)![0];
  assert.equal(path.length, "tool-output/md5/".length + 32);
  assert.deepEqual(parkedOutputKey(path), { digest: path.slice("tool-output/md5/".length) });
});

test("an unparked cut keeps head and tail and says the full output was not kept", () => {
  const text = "H".repeat(500) + "T".repeat(500);
  assert.equal(cutUnparkedToolOutput("short", 10), "short");
  const cut = cutUnparkedToolOutput(text, 50);
  assert.ok(cut.startsWith("H".repeat(100)));
  assert.ok(cut.endsWith("T".repeat(100)));
  assert.match(
    cut,
    /showing the first 100 and last 100 of 1000 chars\. The middle was dropped and the full output was not kept/,
  );
  assert.doesNotMatch(cut, /tool-output\//);
});

test("parkIfOverCap falls back to the inline budget without a store, and to an unparked cut when saving fails", async () => {
  const text = "x".repeat(DEFAULT_INLINE_TOKENS * 4 + 1);
  const bare = await parkIfOverCap(undefined, text, "c1");
  assert.equal(bare.inlineTokens, DEFAULT_INLINE_TOKENS);
  assert.equal(bare.output, undefined);
  assert.match(bare.text, /was not kept/);
  const failing = { inlineTokens: async () => 10, save: async () => Promise.reject(new Error("disk")) };
  const unsaved = await parkIfOverCap(failing, text, "c1");
  assert.equal(unsaved.inlineTokens, 10);
  assert.equal(unsaved.output, undefined);
  assert.match(unsaved.text, /was not kept/);
  const saving = { inlineTokens: async () => 10, save: async () => "sha" };
  const parked = await parkIfOverCap(saving, text, "c1");
  assert.deepEqual(parked.output, { blob: "sha", chars: text.length, shownChars: 40 });
  assert.match(parked.text, /tool-output\/md5\//);
  assert.equal((await parkIfOverCap(saving, "short", "c1")).text, "short");
});

test("tool-output paths name one call by its digest", () => {
  assert.equal(parkedOutputKey("tool-output/toolu_1"), null);
  assert.equal(parkedOutputKey(`tool-output/md5/${"ab".repeat(16)}`)?.digest, "ab".repeat(16));
  assert.equal(parkedOutputKey("tool-output/"), null);
  assert.equal(parkedOutputKey("tool-output/a/b"), null);
  assert.equal(parkedOutputKey(`tool-output/md5/${"AB".repeat(16)}`), null);
  assert.equal(parkedOutputKey("tool-output/md5/abc"), null);
  assert.equal(parkedOutputKey("notes/tool-output/a"), null);
});

const PARKED_PATH = `tool-output/md5/${"ab".repeat(16)}`;

function readBack(parked: Awaited<ReturnType<ToolOutputStore["read"]>>) {
  const written: Array<[string, string]> = [];
  const tc = createToolContext({
    sandbox: {
      readFile: async () => null,
      writeFile: async (_h: unknown, path: string, data: string) => void written.push([path, data]),
    } as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    sessionId: "s1",
    toolOutput: { read: async () => parked } as unknown as ToolOutputStore,
  });
  return { tc, written };
}

test("reading a parked tool output copies the full text onto the computer for execute to slice", async () => {
  const full = Array.from({ length: 30_000 }, (_, i) => `row ${i + 1}`).join("\n");
  const { tc, written } = readBack({ text: full });
  const read = await tc.read(PARKED_PATH);
  assert.deepEqual(written, [[PARKED_PATH, full]]);
  assert.match(
    String(read.content),
    /copied the full output \(\d+ chars\) to tool-output\/md5\/[0-9a-f]{32} on the computer/,
  );
  assert.ok(String(read.content).length < 300);
});

test("an expired parked output says so and writes nothing", async () => {
  const { tc, written } = readBack({ expired: true });
  const read = await tc.read(PARKED_PATH);
  assert.deepEqual(written, []);
  assert.match(String(read.content), /expired after 30 days/);
});
