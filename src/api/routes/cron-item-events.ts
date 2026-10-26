import type { BaseCtx, Route } from "./route.ts";
import { signedEventStream } from "./session-state.ts";

export const cronItemEventsRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  {
    method: "GET",
    path: "/v1/cron-items/events",
    auth: "source",
    handle: signedEventStream("inbox_item", (app, send, onResync) => app.subscribeLedgerEvents(send, { onResync })),
  },
];
