import assert from "node:assert/strict";
import { test } from "node:test";
import { filePreviewKind, previewFile, createFileDragState } from "../src/file-open.ts";
import { JSDOM } from "jsdom";

test("text previews recognize extensions and MIME types without intercepting binary files", () => {
  for (const name of ["notes.md", "notes.MARKDOWN"]) assert.equal(filePreviewKind(name), "markdown");
  assert.equal(filePreviewKind("data.JSON"), "text");
  assert.equal(filePreviewKind("download", "text/markdown; charset=utf-8"), "markdown");
  assert.equal(filePreviewKind("download", "Application/JSON"), "text");
  for (const name of ["data.json", "config.yaml", "config.toml", "notes.txt", "app.ts", "server.log"])
    assert.equal(filePreviewKind(name), "text");
  assert.equal(filePreviewKind("export.csv"), "csv");
  assert.equal(filePreviewKind("export.tsv"), "tsv");
  for (const name of ["report.pdf", "image.png", "archive.zip"]) assert.equal(filePreviewKind(name), null);
  assert.equal(filePreviewKind("data", "text/plain"), "text");
});

test("modified clicks and unsupported files retain the native link behavior", () => {
  const base = { button: 0, preventDefault: () => assert.fail("should remain a native link") };
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
    previewFile({ ...base, [modifier]: true } as unknown as MouseEvent, "notes.md", "/file");
  }
  previewFile({ ...base, button: 1 } as unknown as MouseEvent, "data.json", "/file");
  previewFile(base as unknown as MouseEvent, "report.pdf", "/file");
});

function fixture() {
  const dom = new JSDOM(
    '<main><section id="a"><p><span>Streaming reply</span></p></section><section id="b"></section></main>',
  );
  const doc = dom.window.document;
  const a = doc.querySelector<HTMLElement>("#a")!;
  const b = doc.querySelector<HTMLElement>("#b")!;
  const text = doc.querySelector<HTMLElement>("span")!;
  const changes: boolean[] = [];
  const drag = createFileDragState((value) => changes.push(value));
  a.addEventListener("dragenter", (event) => drag.enter(event as unknown as DragEvent));
  a.addEventListener("dragleave", drag.leave);
  a.addEventListener("drop", drag.reset);
  function dispatch(target: EventTarget, type: string) {
    target.dispatchEvent(new dom.window.Event(type, { bubbles: true, composed: true }));
  }
  return { dom, doc, a, b, text, changes, drag, dispatch };
}

test("a streamed-away target can end the drag without bubbling to the pane", () => {
  const { text, a, dispatch, changes } = fixture();
  let paneLeaves = 0;
  a.addEventListener("dragleave", () => paneLeaves++);
  dispatch(text, "dragenter");
  text.remove();
  dispatch(text, "dragleave");
  assert.equal(paneLeaves, 0);
  assert.deepEqual(changes, [true, false]);
});

test("replacement target enter followed by detached old leave does not hide the overlay", () => {
  const { text, doc, a, dispatch, changes } = fixture();
  dispatch(text, "dragenter");
  text.remove();
  const replacement = doc.createElement("span");
  a.append(replacement);
  dispatch(replacement, "dragenter");
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true]);
  dispatch(replacement, "dragleave");
  assert.deepEqual(changes, [true, false]);
});

test("nested target transitions and repeated enters do not accumulate drag depth", () => {
  const { text, a, dispatch, changes } = fixture();
  dispatch(a, "dragenter");
  dispatch(text, "dragenter");
  dispatch(a, "dragleave");
  dispatch(text, "dragenter");
  assert.deepEqual(changes, [true]);
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true, false]);
});

test("leaving a replaced target and dropping in another pane clears each pane independently", () => {
  const { text, a, b, dispatch, changes } = fixture();
  const otherChanges: boolean[] = [];
  const other = createFileDragState((value) => otherChanges.push(value));
  b.addEventListener("dragenter", (event) => other.enter(event as unknown as DragEvent));
  b.addEventListener("drop", other.reset);
  dispatch(text, "dragenter");
  text.remove();
  dispatch(a, "dragenter");
  dispatch(text, "dragleave");
  dispatch(b, "dragenter");
  dispatch(a, "dragleave");
  dispatch(b, "drop");
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(otherChanges, [true, false]);
});

test("drop resets tracking and a subsequent drag can start", () => {
  const { text, dispatch, changes } = fixture();
  dispatch(text, "dragenter");
  dispatch(text, "drop");
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true, false]);
  dispatch(text, "dragenter");
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true, false, true, false]);
});

test("dispose removes the retained target listener without redrawing a destroyed pane", () => {
  const { text, dispatch, drag, changes } = fixture();
  dispatch(text, "dragenter");
  drag.dispose();
  text.remove();
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true]);
});

test("shadow-root descendants remain tracked when removed from their connected host", () => {
  const { doc, a, dispatch, changes } = fixture();
  const host = doc.createElement("div");
  a.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const text = doc.createElement("span");
  shadow.append(text);
  dispatch(text, "dragenter");
  text.remove();
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true, false]);
});

test("a target removed during the initial overlay draw still delivers its leave", () => {
  const { text, dispatch } = fixture();
  const changes: boolean[] = [];
  const drag = createFileDragState((value) => {
    changes.push(value);
    if (value) text.remove();
  });
  text.addEventListener("dragenter", (event) => drag.enter(event as unknown as DragEvent));
  dispatch(text, "dragenter");
  dispatch(text, "dragleave");
  assert.deepEqual(changes, [true, false]);
});
