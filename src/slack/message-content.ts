import type { SlackFile } from "./attachments.ts";

type SlackNode = Record<string, unknown>;

const isNode = (value: unknown): value is SlackNode =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nodes = (value: unknown): SlackNode[] => (Array.isArray(value) ? value.filter(isNode) : []);

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const textObject = (value: unknown): string => (isNode(value) ? str(value.text) : str(value));

function richTextElementText(el: SlackNode): string {
  switch (el.type) {
    case "text":
      return str(el.text);
    case "link":
      return str(el.text) || str(el.url);
    case "user":
      return `<@${str(el.user_id)}>`;
    case "channel":
      return `<#${str(el.channel_id)}>`;
    case "usergroup":
      return `<!subteam^${str(el.usergroup_id)}>`;
    case "broadcast":
      return `<!${str(el.range)}>`;
    case "emoji":
      return `:${str(el.name)}:`;
    case "rich_text_section":
      return nodes(el.elements).map(richTextElementText).join("");
    case "rich_text_preformatted": {
      const content = nodes(el.elements).map(richTextElementText).join("");
      return `\`\`\`\n${content}\n\`\`\``;
    }
    case "rich_text_quote": {
      const content = nodes(el.elements).map(richTextElementText).join("");
      return content
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    case "rich_text_list": {
      const style = str(el.style);
      const indent = typeof el.indent === "number" ? "  ".repeat(el.indent) : "";
      return nodes(el.elements)
        .map((item, idx) => {
          const prefix = style === "ordered" ? `${idx + 1}. ` : "- ";
          return `${indent}${prefix}${richTextElementText(item)}`;
        })
        .join("\n");
    }
    default:
      return str(el.text);
  }
}

function blockText(block: SlackNode): string {
  switch (block.type) {
    case "section":
      return [textObject(block.text), ...nodes(block.fields).map(textObject)].filter(Boolean).join("\n");
    case "context":
      return nodes(block.elements).map(textObject).filter(Boolean).join(" ");
    case "header":
    case "markdown":
      return textObject(block.text);
    case "rich_text":
      return nodes(block.elements).map(richTextElementText).join("\n");
    default:
      return "";
  }
}

const blocksText = (blocks: unknown): string[] =>
  nodes(blocks)
    .map((block) => blockText(block).trim())
    .filter(Boolean);

function attachmentText(attachment: SlackNode): string {
  const parts = [
    str(attachment.pretext),
    str(attachment.title),
    str(attachment.text),
    ...nodes(attachment.fields).map((field) => [str(field.title), str(field.value)].filter(Boolean).join(": ")),
    ...blocksText(attachment.blocks),
  ]
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length) return parts.join("\n");
  return Array.isArray(attachment.blocks) ? "" : str(attachment.fallback).trim();
}

function forwardLabel(attachment: SlackNode): string {
  const author = str(attachment.author_subname) || str(attachment.author_name) || str(attachment.author_id);
  let channel = "";
  if (str(attachment.channel_name)) channel = `#${str(attachment.channel_name)}`;
  else if (str(attachment.channel_id)) channel = `channel ${str(attachment.channel_id)}`;
  return `forwarded message${author ? ` from ${author}` : ""}${channel ? ` in ${channel}` : ""}`;
}

function nestedMessages(attachment: SlackNode): SlackNode[] {
  const messages = nodes(attachment.message_blocks).flatMap((block) => (isNode(block.message) ? [block.message] : []));
  return nodes(attachment.attachments).length ? [...messages, { attachments: attachment.attachments }] : messages;
}

export function slackMessageContent(message: object): { text: string; files: SlackFile[] } {
  const rendered: string[] = [];
  const files: SlackFile[] = [];
  const seenFiles = new Set<string>();

  const addFile = (file: SlackFile, authorId?: string): void => {
    if (file.id && seenFiles.has(file.id)) return;
    if (file.id) seenFiles.add(file.id);
    files.push(file.user || !authorId ? file : { ...file, user: authorId });
  };

  const visit = (current: SlackNode, nested: boolean): void => {
    for (const attachment of nodes(current.attachments)) {
      if (attachment.is_msg_unfurl !== true && attachment.is_share !== true) {
        const preview = Boolean(attachment.from_url) || attachment.is_app_unfurl === true;
        const text = nested || preview ? "" : attachmentText(attachment);
        if (text) rendered.push(text);
        continue;
      }
      const body = (str(attachment.text) || str(attachment.fallback)).trim();
      rendered.push(body ? `[${forwardLabel(attachment)}] ${body}` : `[${forwardLabel(attachment)}]`);
      for (const file of nodes(attachment.files)) addFile(file, str(attachment.author_id) || undefined);
      for (const inner of nestedMessages(attachment)) visit(inner, true);
    }
  };

  const root = message as SlackNode;
  for (const file of nodes(root.files)) addFile(file);
  visit(root, false);

  const base = String(root.text ?? "") || blocksText(root.blocks).join("\n");
  const text = rendered.length ? [base, ...rendered].filter(Boolean).join("\n") : base;
  return { text, files };
}
