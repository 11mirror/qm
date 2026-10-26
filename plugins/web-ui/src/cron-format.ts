import { addDays, isSameDay } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { relTime } from "./ui.ts";

export interface CronTimingView {
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
}

function humanizeCronInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [604_800_000, "w"],
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
  ];
  for (const [size, label] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${label}`;
  }
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1).replace(/\.0$/, "")}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function cronScheduleSummary(c: CronTimingView): string {
  if (c.schedule.cron) return `cron ${c.schedule.cron.trim().replace(/\s+/g, " ")}`;
  return c.schedule.everyMs != null ? `every ${humanizeCronInterval(c.schedule.everyMs)}` : "one-time";
}

export function cronScheduleDetail(c: CronTimingView): string {
  const summary = cronScheduleSummary(c);
  const label = summary.charAt(0).toUpperCase() + summary.slice(1);
  if (c.schedule.cron) {
    const tz = c.schedule.timezone?.trim();
    return `${label}${tz ? ` (${tz})` : " (default timezone)"}`;
  }
  if (c.schedule.firstFireAt == null) return label;
  if (c.schedule.everyMs != null && c.lastFiredAt != null) return label;
  const runLabel = c.schedule.everyMs != null ? "first run" : "run";
  return `${label} - ${runLabel} ${formatCronDateTime(c.schedule.firstFireAt, Date.now(), c.schedule.timezone)}`;
}

export function cronNextFire(c: CronTimingView): number | null {
  if (c.archived || !c.enabled) return null;
  if (c.nextFireAt != null && Number.isFinite(c.nextFireAt)) return c.nextFireAt;
  if (c.schedule.cron) return null;
  if (c.lastFiredAt == null) return c.schedule.firstFireAt ?? c.createdAt;
  if (c.schedule.everyMs == null) return null;
  return c.lastFiredAt + c.schedule.everyMs;
}

export function cronRunSummary(c: CronTimingView, now = Date.now()): string {
  const next = cronNextFire(c);
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  if (next != null) return `${next <= now ? "due" : "next"} ${formatCronDateTime(next, now, tz)}`;
  if (c.lastFiredAt != null) return `last ${relTime(c.lastFiredAt)}`;
  if (c.schedule.firstFireAt != null) return `first ${formatCronDateTime(c.schedule.firstFireAt, now, tz)}`;
  return "never fired";
}

export function cronRunSummaryTitle(c: CronTimingView): string {
  const tz = c.schedule.cron ? calendarTimezone(c.schedule) : c.schedule.timezone;
  const next = cronNextFire(c);
  if (next != null) return `Next run: ${formatTitleDateTime(next, tz)}`;
  if (c.lastFiredAt != null) return `Last fired: ${formatTitleDateTime(c.lastFiredAt, tz)}`;
  if (c.schedule.firstFireAt != null) return `First run: ${formatTitleDateTime(c.schedule.firstFireAt, tz)}`;
  return "Never fired";
}

export function formatCronDateTime(ms: number, now = Date.now(), timeZone?: string): string {
  const tz = timeZone && validZone(ms, timeZone) && validZone(now, timeZone) ? timeZone : undefined;
  const date = tz ? new TZDate(ms, tz) : new Date(ms);
  const today = tz ? new TZDate(now, tz) : new Date(now);
  const time = new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
  if (isSameDay(date, today)) return time;
  if (isSameDay(date, addDays(today, 1))) return `tomorrow ${time}`;
  const dateOpts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    ...(tz ? { timeZone: tz } : {}),
  };
  return `${new Date(ms).toLocaleDateString([], dateOpts)} ${time}`;
}

function calendarTimezone(schedule: { timezone?: string }): string | undefined {
  return schedule.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

function validZone(ms: number, timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return !Number.isNaN(new TZDate(ms, timeZone).getFullYear());
  } catch {
    return false;
  }
}

function formatTitleDateTime(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat([], {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Date(ms).toLocaleString();
  }
}
