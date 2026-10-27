import { GmailApiError, gmailApi } from "../../connectors/gmail-api.ts";
import { isObj } from "../../util/objects.ts";
import { isResolved } from "../view.ts";
import type { RefreshKit, SourceRefresher } from "./refresh.ts";
import { gmailToken } from "./gmail.ts";

export function createGmailRefresher(kit: RefreshKit, opts: { fetchImpl?: typeof fetch }): SourceRefresher {
  async function gmailRead(owner: string, path: string, token: string): Promise<Record<string, unknown>> {
    const rateLimit = kit.limiter(owner, "gmail:read");
    try {
      return await gmailApi(token, opts.fetchImpl ?? fetch)<Record<string, unknown>>(path, { timeoutMs: 3000 });
    } catch (error) {
      if (!(error instanceof GmailApiError)) throw error;
      if (error.status === 429) rateLimit(error.retryAfterSeconds);
      throw kit.failure(error);
    }
  }

  return {
    connectorToken: gmailToken,
    connectorName: "Google",
    async refresh(owner, item, connectorToken) {
      if (isResolved(item)) return;
      const payload = item.sourcePayload ?? {};
      const token = await connectorToken();
      const meta = isObj(payload.gmail) ? payload.gmail : {};
      if (typeof meta.threadId !== "string") return;
      const body = await gmailRead(owner, `threads/${encodeURIComponent(meta.threadId)}?format=metadata`, token);
      const messages = Array.isArray(body.messages) ? body.messages.filter(isObj) : [];
      const latest = messages
        .filter((m) => Array.isArray(m.labelIds) && !m.labelIds.includes("DRAFT"))
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
        .at(-1);
      if (latest && Array.isArray(latest.labelIds) && latest.labelIds.includes("SENT")) {
        await kit.ownerReplied(
          item,
          Number(latest.internalDate),
          typeof latest.snippet === "string" ? latest.snippet : "",
        );
      }
      if (payload.sourceRefreshError)
        await kit.items.annotate(item.id, { sourceRefreshError: null }, { expectedSourceAt: item.sourceAt });
    },
  };
}
