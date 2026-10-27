import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { createInboxFixture, inboxRuntime } from "./support/inbox-composer-fixture.ts";
import type { LedgerItem } from "../src/inbox-model.ts";

test("sent view pages Gmail messages and opens the matching Google account", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMParser",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const {
      loadSentMail,
      sentMailTpl,
      sentEmailPageTpl,
      resetSentMail,
      openSentEmail,
      openSentEmailById,
      selectedSentEmail,
      sentChatTpl,
    } = await vite.ssrLoadModule("/src/sent-mail.ts");
    const { html, render } = await vite.ssrLoadModule("lit");
    const host = document.getElementById("main")!;
    const draw = () => render(sentMailTpl(draw), host);
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      const next = String(input).includes("pageToken=");
      return Response.json({
        accountEmail: "sam@example.com",
        accountType: "company",
        messages: [
          {
            id: next ? "older" : "newer",
            threadId: "thread-1",
            to: "Alex",
            subject: "Hello",
            snippet: "A &amp; B",
            sentAt: next ? 1000 : 2000,
          },
        ],
        ...(next ? {} : { nextPageToken: "cursor" }),
      });
    };
    await loadSentMail(draw);
    assert.doesNotMatch(urls.at(-1)!, /accountType=/);
    assert.match(host.textContent!, /A & B/);
    assert.equal(host.querySelector("a"), null);
    await loadSentMail(draw, true);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 2);
    const sentRow = host.querySelector(".inbox-sent-row")!;
    assert.ok(sentRow.closest(".inbox-item")!.classList.contains("src-gmail"));
    assert.equal(sentRow.querySelector(".inbox-item-glyph svg")!.getAttribute("width"), "14");
    assert.match(urls.at(-1)!, /accountType=company/);
    assert.match(urls.at(-1)!, /pageToken=cursor/);
    assert.equal(host.querySelector(".inbox-sent-more"), null);
    let chatRequest: Record<string, unknown> = {};
    globalThis.fetch = async (input, options) => {
      if (String(input).endsWith("/inbox/sent-chat")) {
        chatRequest = JSON.parse(String(options?.body));
        return Response.json({ item: { id: "company-chat", thread: [] } });
      }
      assert.match(String(input), /accountType=company$/);
      return Response.json({
        id: "newer",
        accountType: "company",
        threadId: "thread-1",
        from: "Sam",
        cc: "",
        body: "Full sent body",
        html: false,
        attachments: [],
      });
    };
    await openSentEmail(
      {
        id: "newer",
        accountType: "company",
        threadId: "thread-1",
        to: "Alex",
        subject: "Hello",
        snippet: "",
        sentAt: 2000,
      },
      draw,
    );
    assert.equal(chatRequest.accountType, "company");
    assert.equal(chatRequest.messageId, "newer");
    render(sentEmailPageTpl(draw, html`<div class="inbox-chat">Assistant</div>`), host);
    assert.equal(host.querySelector(".inbox-context-text")!.textContent, "Full sent body");
    assert.ok(host.querySelector(".pane-head.inbox-item-head"));
    assert.ok(host.querySelector(".inbox-surface.inbox-item-surface"));
    assert.equal(host.querySelector(".inbox-item-thread > .inbox-chat")!.textContent, "Assistant");
    assert.ok(host.querySelector(".inbox-item-thread > .inbox-sent-actions")!.classList.contains("inbox-sent-actions"));
    assert.match(host.querySelector("a")!.href, /authuser=sam%40example.com/);
    (host.querySelector(".context-back") as HTMLButtonElement).click();
    render(sentMailTpl(draw), host);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 2);
    resetSentMail();
    let detailRequest = "";
    let directChatAccountType: unknown;
    globalThis.fetch = async (input, options) => {
      if (String(input).endsWith("/inbox/sent-chat")) {
        directChatAccountType = JSON.parse(String(options?.body)).accountType;
        return Response.json({ item: { id: "chat", thread: [] } });
      }
      detailRequest = String(input);
      assert.equal(new URL(detailRequest, location.origin).searchParams.has("accountType"), false);
      return Response.json({
        accountType: "company",
        id: "unlisted",
        threadId: "thread-unlisted",
        to: "Alex",
        subject: "Direct link",
        snippet: "",
        sentAt: 2000,
        from: "Sam",
        cc: "",
        body: "Loaded without listing",
        html: false,
        attachments: [],
      });
    };
    await openSentEmailById("unlisted", draw);
    assert.match(detailRequest, /\/api\/inbox\/sent\/unlisted\?$/);
    assert.equal(directChatAccountType, "company");
    render(sentEmailPageTpl(draw), host);
    assert.match(host.textContent!, /Direct link/);
    assert.match(host.textContent!, /Loaded without listing/);
    assert.equal(selectedSentEmail().id, "unlisted");
    render(
      sentEmailPageTpl(
        draw,
        sentChatTpl(draw, (item: { id: string }) => html`<div class="verified-chat">Chat ${item.id}</div>`),
      ),
      host,
    );
    assert.equal(host.querySelector(".inbox-item-thread .verified-chat")!.textContent, "Chat chat");
    resetSentMail();
    globalThis.fetch = async () => {
      throw new Error("Connect Google");
    };
    await loadSentMail(draw);
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Connect Google/);
    assert.equal(host.querySelectorAll(".inbox-sent-row").length, 0);
    resetSentMail();
    assert.deepEqual(domErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});

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

test("Sent opens from a split pane and retains drafts and queued sends after navigation", async () => {
  const domErrors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => domErrors.push(error));
  const dom = new JSDOM('<!doctype html><div id="app"></div><main></main><div id="split"></div>', {
    url: "https://review.example/",
    virtualConsole,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "localStorage",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMParser",
    "CustomEvent",
    "Event",
    "customElements",
  ])
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "window" ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(condition());
  };
  try {
    await vite.ssrLoadModule("/src/shell.ts");
    const inbox = {
      ...(await vite.ssrLoadModule("/src/inbox.ts")),
      ...(await vite.ssrLoadModule("/src/inbox-model.ts")),
    };
    const sent = await vite.ssrLoadModule("/src/sent-mail.ts");
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { splitState } = await vite.ssrLoadModule("/src/split.ts");
    const message = {
      id: "message-1",
      threadId: "thread-1",
      to: "Alex",
      subject: "Subject",
      snippet: "Sent body",
      sentAt: 1,
    };
    const ledger: LedgerItem = {
      id: "sent-ledger",
      cronId: "cron-1",
      dedupeKey: "sent-chat:thread-1",
      state: "held",
      source: "gmail",
      sourcePayload: {
        sentChat: true,
        title: "Subject",
        from: "Sam",
        gmail: { threadId: "thread-1", to: ["Alex"], cc: ["Chris"] },
      },
      proposal: { data: { body: "" }, by: "human", at: 10 },
      thread: [],
      updatedAt: 10,
    };
    const actions: Array<{ kind: string; args: { proposal: Record<string, unknown>; expectedProposalAt: number } }> =
      [];
    let holdEdit = false;
    let releaseEdit: (() => void) | undefined;
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (url.includes("runtime-config")) return Response.json({ ...inboxRuntime, scopeId: "personal:sam" });
      if (url.endsWith("/followup")) {
        const followup = JSON.parse(String(options?.body));
        assert.equal(followup.message, "Send it");
        assert.equal(followup.expectedProposalAt, ledger.proposal!.at);
        ledger.state = "actioned";
        return Response.json({ item: ledger });
      }
      if (url === "/api/inbox") return Response.json({ syncCron: null });
      if (url === "/api/crons/cron-1/items") return Response.json({ items: [] });
      if (url.startsWith("/api/inbox/sent?"))
        return Response.json({ messages: [message], accountType: "default", accountEmail: "sam@example.com" });
      if (url.startsWith("/api/inbox/sent/"))
        return Response.json({ ...message, from: "Sam", cc: "Chris", body: "Sent body", html: false, attachments: [] });
      if (url === "/api/inbox/sent-chat") {
        const body = JSON.parse(String(options?.body));
        assert.equal(body.accountType, "default");
        assert.equal(body.messageId, message.id);
        return Response.json({ item: ledger });
      }
      if (url.endsWith("/action")) {
        const action = JSON.parse(String(options?.body));
        actions.push(action);
        if (action.kind === "edit") {
          if (holdEdit)
            await new Promise<void>((resolve) => {
              releaseEdit = resolve;
            });
          ledger.proposal = { data: action.args.proposal, by: "human", at: ledger.proposal!.at + 1 };
        }
        if (action.kind === "send") ledger.state = "actioned";
        return Response.json({ item: ledger });
      }
      return Response.json({});
    };
    appState.me = { user: "sam", org: "test", permissions: ["inbox"] };
    appState.mainEl = document.querySelector("main");
    appState.currentView = "chats";
    splitState.active = true;
    inbox.inboxState.loaded = true;
    inbox.inboxState.fetchedAt = Date.now();
    const pane = document.getElementById("split")!;
    const mounted = inbox.mountInboxPane({ host: pane, viewId: "all", density: () => "full", onDensityChange() {} });
    [...pane.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent!.trim() === "Sent")!
      .click();
    await waitFor(() => Boolean(pane.querySelector(".inbox-sent-row")));
    pane.querySelector<HTMLButtonElement>(".inbox-sent-row")!.click();
    await waitFor(() => Boolean(document.querySelector("main .inbox-draft-body")));
    assert.equal(appState.currentView, "inbox");
    assert.equal(splitState.active, false);
    assert.match(location.pathname, /\/inbox\/message-1$/);
    assert.match(document.querySelector("main .inbox-sent-message")!.textContent!, /Sent body/);
    assert.ok(document.querySelector("main .inbox-chat"));
    assert.deepEqual(inbox.inboxState.items, []);
    mounted.dispose();
    pane.remove();

    const bodyInput = (): HTMLTextAreaElement => document.querySelector(".inbox-draft-body")!;
    const editBody = (value: string): void => {
      bodyInput().value = value;
      bodyInput().dispatchEvent(new dom.window.Event("input"));
    };
    const close = (): void => document.querySelector<HTMLButtonElement>(".context-back")!.click();
    editBody("Save without blur");
    close();
    await waitFor(() => ledger.proposal!.data.body === "Save without blur");
    assert.equal(sent.selectedSentChat(), null);
    assert.equal(actions.length, 1);

    await sent.openSentEmail(message, inbox.drawAll);
    editBody("Queued save");
    bodyInput().dispatchEvent(new dom.window.Event("blur"));
    inbox.routeInboxHistory("sent");
    await waitFor(() => ledger.proposal!.data.body === "Queued save");
    assert.equal(actions.length, 2);

    await sent.openSentEmail(message, inbox.drawAll);
    editBody("Saving first version");
    holdEdit = true;
    bodyInput().dispatchEvent(new dom.window.Event("blur"));
    await waitFor(() => Boolean(releaseEdit));
    editBody("Send the latest version");
    const recipients = '"Doe, Jane" <jane@example.com>, Alex <alex@example.com>';
    const headers = document.querySelectorAll<HTMLInputElement>(".inbox-draft-headers input");
    for (const header of [headers[0]!, headers[1]!]) {
      header.value = recipients;
      header.dispatchEvent(new dom.window.Event("input"));
    }
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent!.trim() === "Send it")!
      .click();
    inbox.selectInboxView("all");
    inbox.drawAll();
    holdEdit = false;
    releaseEdit!();
    await waitFor(() => ledger.state === "actioned");
    assert.deepEqual(
      actions.map((action) => action.kind),
      ["edit", "edit", "edit", "edit"],
    );
    assert.equal(actions.at(-1)!.args.proposal.body, "Send the latest version");
    assert.equal(actions.at(-1)!.args.expectedProposalAt, ledger.proposal!.at - 1);
    assert.deepEqual(actions.at(-1)!.args.proposal.to, [recipients]);
    assert.deepEqual(actions.at(-1)!.args.proposal.cc, [recipients]);
    assert.equal(ledger.state, "actioned");
    inbox.resetInboxState();
    assert.deepEqual(domErrors, []);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
  }
});
