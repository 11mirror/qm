import { charForName } from "../emoji-picker.ts";
import { el } from "./dom.ts";

function appendInlineMarkdown(parent: Node, text: string) {
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
  let last = 0;
  for (const m of String(text || "").matchAll(re)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const [, , bold, code, label, href, em] = m;
    if (bold) parent.appendChild(el("strong", bold));
    else if (code) parent.appendChild(el("code", code));
    else if (label && href)
      parent.appendChild(el("a", { href, target: "_blank", rel: "noopener", textContent: label }));
    else if (em) parent.appendChild(el("em", em));
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (rest) parent.appendChild(document.createTextNode(rest));
}

function inlineMarkdown(tag: string, text: string) {
  const node = el(tag);
  appendInlineMarkdown(node, text);
  return node;
}

export function renderMarkdown(text: string) {
  const root = el("div.message-body");
  let para: string[] = [];
  let list = null as { ordered: boolean; node: HTMLElement } | null;
  let quote: string[] = [];
  let fence: string[] | null = null;
  const flushPara = () => {
    if (para.length) root.appendChild(inlineMarkdown("p", para.join(" ")));
    para = [];
  };
  const flushList = () => {
    if (list) root.appendChild(list.node);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) root.appendChild(el("blockquote", {}, inlineMarkdown("p", quote.join(" "))));
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  const codeBlock = (lines: string[]) => root.appendChild(el("pre", {}, el("code", lines.join("\n"))));
  for (const line of String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    const fenceMatch = line.match(/^```/);
    const trimmed = line.trim();
    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (fence && fenceMatch) {
      codeBlock(fence);
      fence = null;
    } else if (fence) fence.push(line);
    else if (fenceMatch) {
      flushAll();
      fence = [];
    } else if (!trimmed) flushAll();
    else if (quoteMatch) {
      flushPara();
      flushList();
      quote.push(quoteMatch[1]!);
    } else if (listMatch) {
      flushPara();
      flushQuote();
      const ordered = /\d+\./.test(listMatch[1]!);
      if (list?.ordered !== ordered) {
        flushList();
        list = { ordered, node: el(ordered ? "ol" : "ul") };
      }
      list.node.appendChild(inlineMarkdown("li", listMatch[2]!));
    } else {
      flushList();
      flushQuote();
      para.push(trimmed);
    }
  }
  if (fence) codeBlock(fence);
  flushAll();
  if (!root.childNodes.length) root.appendChild(el("p"));
  return root;
}

export const isXmlishText = (text: unknown) => /^\s*<[A-Za-z][\w-]*(\s|\/?>)/.test(String(text || ""));

export function renderXmlish(text: string) {
  const root = el("div.message-body xml-body");
  const row = (cls: string, depth: number) => {
    const div = root.appendChild(el("div." + cls));
    div.style.paddingLeft = Math.min(depth, 8) * 18 + "px";
    return div;
  };
  const addText = (s: string, depth: number) => {
    const t = s.replace(/^[\s\n]+|[\s\n]+$/g, "");
    if (t) appendInlineMarkdown(row("xml-text", depth), slackUnescape(t.replace(/&quot;/g, '"')));
  };
  const tagRe = /<\/?[A-Za-z][\w-]*(?:\s+[\w-]+(?:="[^"]*")?)*\s*\/?>/g;
  let depth = 0,
    last = 0;
  for (const m of String(text || "").matchAll(tagRe)) {
    addText(text.slice(last, m.index), depth);
    const tok = m[0];
    const closing = tok.startsWith("</");
    if (closing) depth = Math.max(0, depth - 1);
    row("xml-tag" + (closing ? " closing" : ""), depth).textContent = tok;
    if (!closing && !tok.endsWith("/>")) depth += 1;
    last = m.index + tok.length;
  }
  addText(text.slice(last), depth);
  return root;
}

const slackUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Mentions = Record<string, string> | null | undefined;

function slackEntityNode(inner: string, mentions?: Mentions): Node {
  const u = slackUnescape(inner);
  const [id = "", label] = u.slice(1).split("|");
  if (u[0] === "@") return el("span.sm-mention", "@" + (label || mentions?.[id] || id));
  if (u[0] === "#") return el("span.sm-mention", "#" + (label || id));
  if (u[0] === "!") return el("span.sm-mention", "@" + (label || id.split("^")[0]));
  const bar = u.indexOf("|");
  const url = bar === -1 ? u : u.slice(0, bar);
  const text = bar === -1 ? url : u.slice(bar + 1);
  if (!/^(https?:|mailto:|tel:)/i.test(url)) return document.createTextNode(text);
  return el("a", { href: url, target: "_blank", rel: "noopener", textContent: text });
}

function slackAppendMrkdwn(raw: string, parent: Node) {
  const text = slackUnescape(raw);
  const re = /\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|~([^~\n]+)~|(https?:\/\/[^\s<>]+)/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const styled = (
      [
        ["strong", m[1]],
        ["em", m[2]],
        ["s", m[3]],
      ] as const
    ).find(([, value]) => value != null);
    if (styled) parent.appendChild(el(styled[0], styled[1]));
    else {
      let url = m[4]!.replace(/[.,;!?]+$/, "");
      while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)
        url = url.slice(0, -1);
      parent.appendChild(slackEntityNode(url));
      const tail = m[4]!.slice(url.length);
      if (tail) parent.appendChild(document.createTextNode(tail));
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function slackParseInline(text: string, parent: Node, mentions: Mentions) {
  const re = /`([^`\n]+)`|<([^>\n]+)>|:([a-z0-9_+'-]+):/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    if (m.index > last) slackAppendMrkdwn(text.slice(last, m.index), parent);
    const emoji = m[3] != null && charForName(m[3]);
    if (m[1] != null) parent.appendChild(el("code.sm-code", slackUnescape(m[1])));
    else if (m[2] != null) parent.appendChild(slackEntityNode(m[2], mentions));
    else if (emoji) parent.appendChild(document.createTextNode(emoji));
    else slackAppendMrkdwn(m[0], parent);
    last = re.lastIndex;
  }
  if (last < text.length) slackAppendMrkdwn(text.slice(last), parent);
}

export function slackParseText(raw: string | null | undefined, mentions?: Mentions) {
  const frag = document.createDocumentFragment();
  if (!raw) return frag;
  raw.split("```").forEach((part, i) => {
    if (i % 2 === 1)
      return frag.appendChild(el("pre", {}, el("code", slackUnescape(part.replace(/^\n/, "").replace(/\n$/, "")))));
    let quote: HTMLElement | null = null;
    part.split("\n").forEach((line, lineIndex) => {
      if (/^(?:>|&gt;) ?/.test(line)) {
        if (quote) quote.append("\n");
        else quote = frag.appendChild(el("blockquote"));
        slackParseInline(line.replace(/^(?:>|&gt;) ?/, ""), quote, mentions);
      } else {
        if (lineIndex && !quote) frag.append("\n");
        quote = null;
        slackParseInline(line, frag, mentions);
      }
    });
  });
  return frag;
}
