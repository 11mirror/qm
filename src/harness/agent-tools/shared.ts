import { Type } from "typebox";

export const optionalString = (description: string) => Type.Optional(Type.String({ description }));
export const optionalBoolean = (description: string) => Type.Optional(Type.Boolean({ description }));
export const optionalInteger = (description: string) => Type.Optional(Type.Integer({ description }));

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }], details: {} };
}

const LIST_PAGE_SIZE = 25;
export function pageOf<T>(
  items: T[],
  opts: { offset?: number; limit?: number },
): { page: T[]; offset: number; note: string | null } {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? LIST_PAGE_SIZE);
  const page = items.slice(offset, offset + limit);
  const last = offset + page.length;
  if (page.length === 0) return { page, offset, note: `nothing at offset ${offset} — ${items.length} total` };
  if (items.length > last)
    return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; next page: offset: ${last}` };
  if (offset > 0) return { page, offset, note: `showing ${offset + 1}–${last} of ${items.length}; end of list` };
  return { page, offset, note: null };
}

export const outsideWorkspace = (path: string): string =>
  `[not in the computer's workspace: ${path}; only workspace files can be read, so copy it there or name it relative to the workspace]`;

export const sandboxSelector = (description: string) => Type.Optional(Type.String({ minLength: 1, description }));

export function fmtCandidates(candidates: ReadonlyArray<{ label: string; id: string }> | undefined): string {
  return candidates?.length ? `\nCandidates: ${candidates.map((c) => `${c.label} (${c.id})`).join(", ")}` : "";
}
