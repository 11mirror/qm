import { html, type TemplateResult } from "lit";
import { marked } from "marked";
import { ArrowUpRight, Check } from "lucide";
import { icon } from "./icons.ts";
import { connectorLogo } from "./connector-logo.ts";

const LINK_RE = /https?:\/\/[^\s<>()[\]]+/gi;

export const CONNECTOR_LABELS: Record<string, { name: string; hosts: string }> = {
  google: { name: "Google Workspace", hosts: "Gmail, Calendar, Drive, Sheets" },
  slack: { name: "Slack", hosts: "Channels & messages" },
  notion: { name: "Notion", hosts: "Pages & databases" },
  linear: { name: "Linear", hosts: "Issues & projects" },
  github: { name: "GitHub", hosts: "Repos, issues & PRs" },
  dropbox: { name: "Dropbox", hosts: "Files & folders" },
  x: { name: "X (Twitter)", hosts: "Posts & profile" },
  zoom: { name: "Zoom", hosts: "Meetings" },
};

export interface ConnectorLink {
  provider: string;
  url: string;
  label?: string;
}

export function connectorLinksIn(text: string, trustedOrigin?: string): ConnectorLink[] {
  const labels = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi)) {
    const label = m[1]!.trim();
    if (label && !labels.has(m[2]!)) labels.set(m[2]!, label);
  }
  const out: ConnectorLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const url = m[0].replace(/[*_]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.username || parsed.password) continue;
    if (parsed.origin === "https://connect.composio.dev" && /^\/link\/lk_[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
      const label = labels.get(url);
      if (!out.some((l) => l.url === url)) out.push({ provider: "composio", url, ...(label ? { label } : {}) });
      continue;
    }
    if (
      trustedOrigin &&
      parsed.origin === trustedOrigin &&
      parsed.pathname === "/settings/slack-settings" &&
      parsed.search === "?slack=setup"
    ) {
      if (!out.some((l) => l.provider === "slack-bot")) out.push({ provider: "slack-bot", url });
      continue;
    }
    if (trustedOrigin && parsed.origin !== trustedOrigin) continue;
    if (!/^\/(?:connect\/redeem|v1\/connectors\/oauth\/consent\/redeem)\/[^/]+$/.test(parsed.pathname)) continue;
    const provider = parsed.searchParams.get("p") ?? "";
    if (!CONNECTOR_LABELS[provider]) continue;
    if (!out.some((l) => l.url === url)) out.push({ provider, url });
  }
  return out;
}

const EMPH = String.raw`(?:\*\*|\*|__|_)`;

export function stripConnectorLinks(text: string, links = connectorLinksIn(text)): string {
  for (const { url } of links) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text
      .replace(new RegExp(`${EMPH}?\\[[^\\]]*\\]\\(\\s*<?${escaped}>?\\s*\\)${EMPH}?`, "g"), "")
      .replace(new RegExp(`${EMPH}?<?${escaped}(?=$|[\\s<>()[\\]*_])>?${EMPH}?`, "g"), "");
  }
  return text.replace(/[ \t]+$/gm, "").trim();
}

export function connectorService(link: ConnectorLink): string {
  if (link.provider !== "composio") return link.provider;
  const label = (link.label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const services: Array<[string, RegExp]> = [
    ["gmail", /\bgmail\b/],
    ["googlecalendar", /\b(?:google calendar|gcalendar)\b|^(?:connect |authorize )?calendar$/],
    ["googledrive", /\b(?:google drive|gdrive)\b/],
    ["googlesheets", /\b(?:google sheets|gsheets)\b/],
    ["google", /\b(?:google|google workspace)\b/],
    ["slack", /\bslack\b/],
    ["notion", /\bnotion\b/],
    ["linear", /\blinear\b/],
    ["github", /\bgithub\b/],
    ["dropbox", /\bdropbox\b/],
    ["x", /\b(?:twitter|x)\b/],
  ];
  const matches = services.filter(([, pattern]) => pattern.test(label));
  const hasGoogleProduct = matches.some(([id]) => id.startsWith("google") && id !== "google");
  const specific = matches.filter(([id]) => id !== "google" || !hasGoogleProduct);
  return specific.length === 1 ? specific[0]![0] : "";
}

export function connectorCard(
  link: ConnectorLink,
  connected = false,
  withReturnTo: (url: string) => string = (url) => url,
): TemplateResult {
  const composio = link.provider === "composio";
  const name = CONNECTOR_LABELS[link.provider]?.name ?? "your account";
  const service = connectorService(link);
  if (!composio && connected) {
    return html`<div class="connector-widget connected" role="status">
      ${connectorLogo(service)}
      <span class="connector-widget-text"><strong>Connected ${name}</strong><small>Ready to use in chat</small></span>
      <span class="connector-widget-status" aria-hidden="true">${icon(Check, 16)}</span>
    </div>`;
  }
  return html`<a
    class="connector-widget"
    href=${composio ? link.url : withReturnTo(link.url)}
    target="_blank"
    rel="noreferrer"
    title="Opens in a new tab"
  >
    ${connectorLogo(service)}
    <span class="connector-widget-text"
      ><strong>${(composio && link.label) || `Connect ${name}`}</strong> <small>Authorize access · New tab</small></span
    >
    <span class="connector-widget-action" aria-hidden="true">${icon(ArrowUpRight, 16)}</span>
  </a>`;
}

export type SetupContent =
  { type: "text"; text: string } | { type: "setup"; toolkit?: string } | { type: "slack" | "slack-account" };

const DIRECTIVES = {
  "::connect-apps{}": "setup",
  "::add-to-slack{}": "slack",
  "::link-slack-account{}": "slack-account",
} as const;
const APP_DIRECTIVE = /^::connect-apps\{toolkit=("?)([a-z0-9_-]{1,100})\1\}$/;

export function setupContent(text: string): SetupContent[] {
  const parts: SetupContent[] = [];
  for (const token of marked.lexer(text)) {
    const raw = token.raw.trim();
    const app = token.type === "paragraph" ? APP_DIRECTIVE.exec(raw) : null;
    if (app) parts.push({ type: "setup", toolkit: app[2]! });
    else if (token.type === "paragraph" && Object.hasOwn(DIRECTIVES, raw))
      parts.push({ type: DIRECTIVES[raw as keyof typeof DIRECTIVES] });
    else {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += token.raw;
      else parts.push({ type: "text", text: token.raw });
    }
  }
  return parts;
}
