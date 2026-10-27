import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "../support/admin-fixture.ts";

test("a rejected fetch or an interrupted body becomes a visible failure", async () => {
  const interrupted = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body interrupted"));
        },
      }),
    );
  for (const files of [
    () => {
      throw new Error("network disconnected");
    },
    interrupted,
  ]) {
    const admin = await mountAdmin("/settings/files", { "/scopes": { scopes: [] }, "/files": files });
    await admin.settle();
    assert.equal(admin.document.querySelector("#view-data .empty")!.textContent, "Network request failed.");
    admin.close();
  }
});
