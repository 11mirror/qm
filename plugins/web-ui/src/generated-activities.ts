import { parseSuggestedActivities, type SuggestedActivity } from "../../chassis/src/suggested-activities.ts";
import { api } from "./core-bridge";
import { swallowAs } from "../../chassis/src/errors.ts";
import type { Me } from "./shell-state";

const REFRESH_DEBOUNCE_MS = 3_000;
const requests = new WeakMap<Me, { until: number; pending: Promise<void> }>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export function loadGeneratedActivities(
  me: Me,
  onChange?: () => void,
  refresh = false,
  active: () => boolean = () => true,
): Promise<void> {
  if (!me.suggestedActivitiesGeneration) return Promise.resolve();
  const cached = requests.get(me);
  if (!refresh && cached && cached.until > Date.now()) return cached.pending.then(onChange);
  const request = { until: Date.now() + 5 * 60_000, pending: Promise.resolve() };
  requests.set(me, request);
  request.pending = (async () => {
    let poll = refresh;
    while (requests.get(me) === request && active()) {
      const response = await api<{ activities: unknown; pending?: boolean }>("/api/suggested-activities", {
        method: "POST",
        body: JSON.stringify({
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          poll,
          ...(refresh ? { refresh: true } : {}),
        }),
      });
      if (requests.get(me) !== request) return;
      me.suggestedActivities = parseSuggestedActivities(JSON.stringify(response.activities));
      onChange?.();
      if (!response.pending) return;
      poll = true;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    request.until = 0;
  })().catch(swallowAs("web-ui: load generated activities", undefined));
  return request.pending;
}

export function dismissGeneratedActivity(
  me: Me,
  activity: SuggestedActivity,
  onChange: () => void,
  active: () => boolean = () => true,
): void {
  requests.delete(me);
  me.suggestedActivities = me.suggestedActivities?.filter((candidate) => candidate.id !== activity.id);
  onChange();
  clearTimeout(refreshTimer);
  const saved = api("/api/suggested-activities/dismiss", {
    method: "POST",
    body: JSON.stringify({ id: activity.id }),
  }).catch(swallowAs("web-ui: dismiss suggested activity", undefined));
  refreshTimer = setTimeout(() => {
    void saved.then(() => loadGeneratedActivities(me, onChange, true, active));
  }, REFRESH_DEBOUNCE_MS);
}
