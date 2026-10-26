import { fmtTime } from "./format.ts";

export interface Schedule {
  cron?: string;
  timezone?: string;
  everyMs?: number | null;
  firstFireAt?: number | string | null;
}

function cronFieldSet(raw: string, min: number, max: number, dow = false) {
  const values = new Set<number>();
  const pieces = String(raw || "").split(",");
  let any = raw === "*";
  for (const piece of pieces) {
    if (!piece) return null;
    const [base = "", stepRaw] = piece.split("/");
    const step = stepRaw == null ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
    let start: number, end: number;
    if (base === "*") {
      start = min;
      end = max;
      any = pieces.length === 1 && step === 1;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map(Number) as [number, number];
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      start = a;
      end = b;
    } else {
      const n = Number(base);
      if (!Number.isInteger(n)) return null;
      start = dow && n === 7 ? 0 : n;
      end = start;
    }
    if (start < min || end > max || start > end) return null;
    for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n);
  }
  const normalized = [...values].filter((n) => n >= min && n <= (dow ? 6 : max)).sort((a, b) => a - b);
  return normalized.length ? { any, values: normalized } : null;
}

export function humanCron(expr: string) {
  const clean = String(expr || "")
    .trim()
    .replace(/\s+/g, " ");
  const parts = clean.split(" ");
  if (parts.length !== 5) return "cron " + clean;
  const [m = "", h = "", d = "", mo = "", w = ""] = parts;
  const minutes = cronFieldSet(m, 0, 59);
  const hours = cronFieldSet(h, 0, 23);
  const dom = cronFieldSet(d, 1, 31);
  const months = cronFieldSet(mo, 1, 12);
  const dow = cronFieldSet(w, 0, 7, true);
  if (!minutes || !hours || !dom || !months || !dow) return "cron " + clean;
  const minute = minutes.values.length === 1 ? minutes.values[0]! : null;
  const hour = hours.values.length === 1 ? hours.values[0]! : null;
  if (minute != null && hour != null && dom.any && months.any) {
    const suffix = hour < 12 ? "AM" : "PM";
    const time = (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const full = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
    if (dow.any) return "daily " + time;
    if (dow.values.join(",") === "1,2,3,4,5") return "weekdays " + time;
    return (dow.values.length === 1 ? full[dow.values[0]!] : dow.values.map((v) => days[v]).join(", ")) + " " + time;
  }
  if (minute != null && hours.any && dom.any && months.any && dow.any)
    return minute === 0 ? "hourly" : "hourly at :" + String(minute).padStart(2, "0");
  return "cron " + clean;
}

export function shortSchedule(sch: Schedule | null | undefined) {
  if (!sch) return "Never";
  if (sch.cron) {
    const label = humanCron(sch.cron);
    return label.startsWith("cron ") ? sch.cron : label;
  }
  if (sch.everyMs != null) {
    for (const [u, n] of Object.entries({ d: 86400000, h: 3600000, m: 60000, s: 1000 }))
      if (sch.everyMs >= n && sch.everyMs % n === 0) return "every " + sch.everyMs / n + u;
    return "every " + sch.everyMs + " ms";
  }
  return sch.firstFireAt ? "once" : "Never";
}

export function fmtSchedule(sch: Schedule | null | undefined) {
  if (!sch) return "None";
  if (sch.cron) {
    const label = humanCron(sch.cron);
    return (
      label +
      (sch.timezone ? " (" + sch.timezone + ")" : " (default timezone)") +
      (label === "cron " + sch.cron ? "" : " · " + sch.cron)
    );
  }
  if (sch.everyMs != null) return shortSchedule(sch);
  return sch.firstFireAt ? "once at " + fmtTime(sch.firstFireAt) : "Never";
}
