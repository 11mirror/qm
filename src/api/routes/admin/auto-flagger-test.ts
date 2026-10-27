import { swallow } from "../../../util/errors.ts";
import { audit } from "../shared.ts";
import { badRequest, orgAdmin } from "./common.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { securityScreenSystemPrompt, type SecurityScreenVerdict } from "../../../security/security-screen.ts";
import { defaultAutoFlaggerConfig, parseAutoFlaggerDraft, type AutoFlaggerDraft } from "../admin-resources.ts";
import type { ScreenSample } from "../../../sessions/session-store.ts";
import type { SecurityScreenProbe } from "../../../security/security-screener.ts";
import { tenant } from "../../../tenant.ts";

const DEFAULT_WINDOW = 100;
const MAX_WINDOW = 500;
const CONCURRENCY = 4;
const PER_SAMPLE_TIMEOUT_MS = 20_000;
const RUN_DEADLINE_MS = 120_000;

interface RunTotals {
  flagged: number;
  allowed: number;
  unscreened: number;
  errors: number;
}

const emptyTotals = (): RunTotals => ({ flagged: 0, allowed: 0, unscreened: 0, errors: 0 });

const rate = (flagged: number, scored: number): number | null =>
  scored > 0 ? Math.round((flagged / scored) * 10_000) / 10_000 : null;

async function replay(
  probe: SecurityScreenProbe,
  config: AutoFlaggerDraft,
  samples: readonly ScreenSample[],
  actorId: string,
  deadline: number,
): Promise<{ totals: RunTotals; verdicts: Map<string, "strict" | "auto">; complete: boolean }> {
  const systemPrompt = securityScreenSystemPrompt(config.rubric);
  const totals = emptyTotals();
  const verdicts = new Map<string, "strict" | "auto">();
  let next = 0;
  let complete = true;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline) {
        complete = false;
        return;
      }
      const sample = samples[next++];
      if (!sample) return;
      let verdict: SecurityScreenVerdict | undefined;
      try {
        verdict = await probe({
          payload: sample.payload,
          modelId: config.modelId,
          systemPrompt,
          actorId,
          scopeLabel: sample.scopeLabel,
          signal: AbortSignal.timeout(PER_SAMPLE_TIMEOUT_MS),
        });
      } catch (error) {
        swallow("auto-flagger test: probe", error);
        verdict = undefined;
      }
      if (!verdict) totals.errors += 1;
      else if (verdict.unscreened) totals.unscreened += 1;
      else if (verdict.decision === "strict") {
        totals.flagged += 1;
        verdicts.set(sample.id, "strict");
      } else {
        totals.allowed += 1;
        verdicts.set(sample.id, "auto");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, samples.length) }, worker));
  return { totals, verdicts, complete };
}

export async function testAutoFlagger(ctx: ApiCtx): Promise<RouteResult> {
  const scope = tenant().orgScope;
  const requestedScope = decodeURIComponent(ctx.params.scope ?? scope);
  const authz = await orgAdmin(ctx);
  const { actor } = authz;
  if (requestedScope !== scope) throw badRequest("the Auto flagger is org-wide; request an org scope");
  await ctx.deps.refreshModels?.();
  const body = (ctx.body ?? {}) as { window?: unknown; modelId?: unknown; rubric?: unknown; compare?: unknown };
  const requestedWindow = body.window === undefined ? DEFAULT_WINDOW : Number(body.window);
  if (!Number.isInteger(requestedWindow) || requestedWindow < 1 || requestedWindow > MAX_WINDOW)
    throw badRequest(`window must be an integer between 1 and ${MAX_WINDOW}`);
  const { sessions, screenSecurity, config: configStore } = ctx.deps;
  if (!sessions || !screenSecurity || !configStore)
    return reply(501, {
      error: "unsupported",
      message: "this deployment has no screening model wired, so the flagger cannot be tested",
    });
  const saved = configStore.setting("autoFlagger");
  const effective: AutoFlaggerDraft = saved
    ? { modelId: saved.modelId, rubric: saved.rubric }
    : defaultAutoFlaggerConfig(ctx.deps);
  const draftGiven = body.modelId !== undefined || body.rubric !== undefined;
  const parsed = draftGiven
    ? await parseAutoFlaggerDraft(ctx.deps, body)
    : ({ value: effective } as { value: AutoFlaggerDraft });
  if ("error" in parsed) throw badRequest(parsed.error);
  const candidate = parsed.value;
  const samples = await sessions.listScreenSamples(requestedWindow);
  const startedAt = Date.now();
  const deadline = startedAt + RUN_DEADLINE_MS;
  if (!samples.length) {
    audit(ctx.deps, {
      principalId: actor.id,
      action: "auto_flagger.test",
      resource: "auto-flagger",
      scopeLabel: scope,
      status: "empty",
      detail: JSON.stringify({ window: requestedWindow, sampled: 0 }),
    });
    return ok({
      scopeId: scope,
      window: requestedWindow,
      sampled: 0,
      modelId: candidate.modelId,
      message: "no past screenings are recorded yet, so there is nothing to replay",
    });
  }
  const run = await replay(screenSecurity, candidate, samples, actor.id, deadline);
  const scored = run.totals.flagged + run.totals.allowed;
  const wantCompare =
    body.compare === true && (candidate.modelId !== effective.modelId || candidate.rubric !== effective.rubric);
  const baseline = wantCompare ? await replay(screenSecurity, effective, samples, actor.id, deadline) : null;
  let changed: number | null = null;
  if (baseline) {
    changed = 0;
    for (const [id, verdict] of run.verdicts) {
      const before = baseline.verdicts.get(id);
      if (before && before !== verdict) changed += 1;
    }
  }
  const result = {
    scopeId: scope,
    window: requestedWindow,
    sampled: samples.length,
    scored,
    flagged: run.totals.flagged,
    allowed: run.totals.allowed,
    unscreened: run.totals.unscreened,
    errors: run.totals.errors,
    flagRate: rate(run.totals.flagged, scored),
    oldestAt: samples[samples.length - 1]?.createdAt ?? null,
    newestAt: samples[0]?.createdAt ?? null,
    modelId: candidate.modelId,
    saved: !!saved,
    partial: !run.complete || !(baseline?.complete ?? true),
    durationMs: Date.now() - startedAt,
    ...(baseline
      ? {
          baseline: {
            modelId: effective.modelId,
            flagged: baseline.totals.flagged,
            flagRate: rate(baseline.totals.flagged, baseline.totals.flagged + baseline.totals.allowed),
            changed,
          },
        }
      : {}),
  };
  audit(ctx.deps, {
    principalId: actor.id,
    action: "auto_flagger.test",
    resource: "auto-flagger",
    scopeLabel: scope,
    status: result.partial ? "partial" : "ok",
    detail: JSON.stringify({
      window: requestedWindow,
      sampled: result.sampled,
      flagged: result.flagged,
      errors: result.errors,
      modelId: candidate.modelId,
      compared: !!baseline,
    }),
  });
  return ok(result);
}
