import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("an HTML sent email keeps its line breaks and drops styles in the page and the chat text", async (t) => {
  const { dom, vite, host, close } = await createInboxFixture({ dom: { url: "http://localhost/web-ui/" } });
  t.after(close);
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: dom.window.DOMParser });
  let chatText = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    if (String(input).endsWith("/inbox/sent-chat")) {
      chatText = JSON.parse(String(init?.body)).text;
      return Response.json({ item: { id: "chat", thread: [] } });
    }
    return Response.json({
      id: "m1",
      threadId: "t1",
      to: "Alex",
      subject: "Plan",
      snippet: "",
      sentAt: 1000,
      from: "Sam",
      cc: "",
      html: true,
      attachments: [],
      body: "<style>p { color: red }</style><div><p>Hi Alex,</p><p>Line one<br>\n  line two</p><ul><li>First</li><li>Second</li></ul><blockquote>Quoted</blockquote>Thanks</div>",
    });
  });
  await vite.ssrLoadModule("/src/shell.ts");
  const { openSentEmailById, sentEmailPageTpl } = await vite.ssrLoadModule("/src/sent-mail.ts");
  const { render } = await vite.ssrLoadModule("lit");
  const draw = () => render(sentEmailPageTpl(draw), host);
  await openSentEmailById("m1", draw);
  draw();
  const expected = "Hi Alex,\nLine one\nline two\nFirst\nSecond\nQuoted\nThanks";
  assert.equal(host.querySelector(".inbox-context-text")!.textContent, expected);
  assert.equal(chatText, expected);
});
