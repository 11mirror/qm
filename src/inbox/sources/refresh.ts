import type { InboxItem } from "../../types.ts";
import type { InboxLedger } from "../ledger.ts";

export interface RefreshKit {
  items: Pick<InboxLedger, "annotate">;
  now(): number;
  limiter(owner: string, key: string): (retryAfterSeconds: number) => void;
  failure(cause: Error): Error;
  cached(key: string, load: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>;
  ownerReplied(item: InboxItem, at: number, text: string): Promise<void>;
  recordFailure(owner: string, subject: string, error: unknown): void;
}

export interface SourceRefresher {
  connectorHost: string;
  connectorName: string;
  refresh(owner: string, item: InboxItem, connectorToken: () => Promise<string>): Promise<void>;
  refreshAvatars?(owner: string, item: InboxItem): Promise<void>;
}
