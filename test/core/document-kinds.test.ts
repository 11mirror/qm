import assert from "node:assert/strict";
import { test } from "node:test";
import { documentExtension } from "../../src/core/document-kinds.ts";

test("nameless files are classified by their MIME type, including common aliases", () => {
  for (const [mimetype, ext] of [
    ["application/rtf", "rtf"],
    ["text/rtf", "rtf"],
    ["text/javascript", "js"],
    ["application/javascript", "js"],
    ["text/x-unknown", "txt"],
  ])
    assert.equal(documentExtension({ name: "upload", mimetype }), ext, mimetype);
});
