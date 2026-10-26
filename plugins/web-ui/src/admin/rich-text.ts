import { charForName } from "../emoji-picker.ts";
import { decodeSlackEntities, splitSlackWire } from "../slack-text.ts";
import { el } from "./dom.ts";

export const isXmlishText = (text: unknown) => /^\s*<[A-Za-z][\w-]*(\s|\/?>)/.test(String(text || ""));

type Mentions = Record<string, string> | null | undefined;

function link(href: string, label: string) {
  return el("a", { href, target: "_blank", rel: "noopener", textContent: label });
}

function appendMrkdwn(text: string, parent: Node) {
  const re = /\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|~([^~\n]+)~|(https?:\/\/[^\s<>]+)|:([a-z0-9_+'-]+):/g;
  let last = 0,
    m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const [whole, bold, em, strike, bare, emojiName] = m;
    const emoji = emojiName != null && charForName(emojiName);
    if (bold != null) parent.appendChild(el("strong", bold));
    else if (em != null) parent.appendChild(el("em", em));
    else if (strike != null) parent.appendChild(el("s", strike));
    else if (emoji) parent.appendChild(document.createTextNode(emoji));
    else if (bare != null) {
      let url = bare.replace(/[.,;!?]+$/, "");
      while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)
        url = url.slice(0, -1);
      parent.appendChild(link(url, url));
      if (bare.length > url.length) parent.appendChild(document.createTextNode(bare.slice(url.length)));
    } else parent.appendChild(document.createTextNode(whole));
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function appendLine(line: string, parent: Node, mentions: Mentions) {
  line.split(/(`[^`\n]+`)/).forEach((part, i) => {
    if (i % 2) return parent.appendChild(el("code.sm-code", decodeSlackEntities(part.slice(1, -1))));
    for (const seg of splitSlackWire(part)) {
      if (seg.kind === "mention")
        parent.appendChild(el("span.sm-mention", "@" + (mentions?.[seg.handle] || seg.handle)));
      else if (seg.kind === "link") parent.appendChild(link(seg.href, seg.label));
      else appendMrkdwn(seg.text, parent);
    }
  });
}

export function slackParseText(raw: string | null | undefined, mentions?: Mentions) {
  const frag = document.createDocumentFragment();
  if (!raw) return frag;
  raw.split("```").forEach((part, i) => {
    if (i % 2 === 1)
      return frag.appendChild(
        el("pre", {}, el("code", decodeSlackEntities(part.replace(/^\n/, "").replace(/\n$/, "")))),
      );
    let quote: HTMLElement | null = null;
    part.split("\n").forEach((line, lineIndex) => {
      if (/^(?:>|&gt;) ?/.test(line)) {
        if (quote) quote.append("\n");
        else quote = frag.appendChild(el("blockquote"));
        appendLine(line.replace(/^(?:>|&gt;) ?/, ""), quote, mentions);
      } else {
        if (lineIndex && !quote) frag.append("\n");
        quote = null;
        appendLine(line, frag, mentions);
      }
    });
  });
  return frag;
}
