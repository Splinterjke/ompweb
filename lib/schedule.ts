/**
 * Pure schedule math for the Schedulers feature. No I/O, no timers — every
 * function here is deterministic given `from`, so it is unit-testable and can
 * run on the server (preview API) or in tests.
 *
 * Two schedule families:
 *  - interval:   "every N minutes/hours/days" — ms-based, next = from + N.
 *  - cron-based: daily / weekdays / weekly / custom 5-field cron — converted
 *    to a cron expression and evaluated with a minute-resolution next-run
 *    search.
 *
 * Local calendar arithmetic is used throughout: a schedule of "09:00" means
 * 09:00 in the server's local timezone, regardless of DST transitions.
 */

export type ScheduleUnit = "minutes" | "hours" | "days";
/** User-input validation error carrying a stable `code` for 400 responses. */
export class ScheduleValidationError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ScheduleValidationError(code);
}
export type ScheduleSpec =
  | { kind: "interval"; every: number; unit: ScheduleUnit }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; hour: number; minute: number; weekdays: number[] } // 0=Sun..6=Sat
  | { kind: "cron"; expr: string }
  | { kind: "manual" };

export const SCHEDULE_KINDS = ["interval", "daily", "weekdays", "weekly", "cron", "manual"] as const;

const UNITS: Record<ScheduleUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

const MAX_INTERVAL_MS = 30 * 86_400_000; // sanity cap: 30 days
const MIN_INTERVAL_MS = 1_000;

/** Validate a spec structurally (ranges, presence). Throws with a short,
 *  stable message on failure; returns the spec on success. */
export function validateSchedule(spec: unknown): ScheduleSpec {
  if (typeof spec !== "object" || spec === null) fail("schedule_required");
  const s = spec as Record<string, unknown>;
  const kind = s.kind;
  if (typeof kind !== "string" || !(SCHEDULE_KINDS as readonly string[]).includes(kind)) {
    fail("schedule_kind_invalid");
  }
  if (kind === "manual") return { kind: "manual" };
  if (kind === "interval") {
    const every = num(s.every, "schedule_every_invalid");
    const unit = s.unit;
    if (unit !== "minutes" && unit !== "hours" && unit !== "days") fail("schedule_unit_invalid");
    const ms = every * UNITS[unit];
    if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) {
      fail("schedule_every_out_of_range");
    }
    return { kind: "interval", every, unit };
  }
  if (kind === "cron") {
    if (typeof s.expr !== "string" || !s.expr.trim()) fail("schedule_cron_required");
    parseCron(s.expr.trim()); // throws on invalid
    return { kind: "cron", expr: s.expr.trim() };
  }
  const hour = num(s.hour, "schedule_time_invalid");
  const minute = num(s.minute, "schedule_time_invalid");
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) fail("schedule_time_invalid");
  if (kind === "daily") return { kind, hour, minute };
  if (kind === "weekdays") return { kind, hour, minute };
  if (kind === "weekly") {
    if (!Array.isArray(s.weekdays) || s.weekdays.length === 0) fail("schedule_weekdays_required");
    const days = s.weekdays.map((d) => num(d, "schedule_weekdays_invalid"));
    if (days.some((d) => d < 0 || d > 6)) fail("schedule_weekdays_invalid");
    return { kind, hour, minute, weekdays: [...new Set(days)].sort((a, b) => a - b) };
  }
  fail("schedule_kind_invalid");
}

function num(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(code);
  return value;
}

/** Millisecond length of an interval schedule. */
export function intervalMs(spec: ScheduleSpec): number {
  if (spec.kind !== "interval") throw new Error("not_an_interval");
  return spec.every * UNITS[spec.unit];
}

/** Convert a cron-based spec to its 5-field cron expression. */
export function scheduleToCron(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "daily":
      return `${spec.minute} ${spec.hour} * * *`;
    case "weekdays":
      return `${spec.minute} ${spec.hour} * * 1-5`;
    case "weekly":
      return `${spec.minute} ${spec.hour} * * ${[...spec.weekdays].sort((a, b) => a - b).join(",")}`;
    case "cron":
      return spec.expr;
    case "interval":
      throw new Error("interval_not_cron");
    case "manual":
      throw new Error("manual_not_cron");
  }
}

/* ─────────────────────────── cron parsing ─────────────────────────── */

export interface CronSets {
  minutes: number[]; // sorted
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[]; // 0=Sun..6=Sat
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_BOUNDS = [
  { max: 59, name: "minute" },
  { max: 23, name: "hour" },
  { max: 31, name: "day-of-month" },
  { max: 12, name: "month" },
  { max: 7, name: "day-of-week" },
];

/** Parse a standard 5-field cron expression. Supports `*`, `N`, `A-B`,
 *  comma lists, and `/step` (on `*`, `A-B`, or `N`). Day-of-week accepts 0-7
 *  (7 = Sunday). Throws on any malformation. */
export function parseCron(expr: string): CronSets {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) fail("cron_fields_5");
  const sets = fields.map((field, i) => {
    const { max, name } = FIELD_BOUNDS[i];
    if (!field) fail("cron_field_empty");
    const values = new Set<number>();
    for (const item of field.split(",")) {
      if (!item) fail("cron_field_empty");
      const [rangePart, stepPart] = item.split("/");
      let step = 1;
      if (stepPart !== undefined) {
        if (!/^\d+$/.test(stepPart)) fail("cron_step_invalid");
        step = Number(stepPart);
        if (step < 1) fail("cron_step_invalid");
      }
      let lo: number;
      let hi: number;
      if (rangePart === "*") {
        lo = 0;
        hi = max;
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number(rangePart);
        hi = stepPart !== undefined ? max : lo; // `N/step` = N..max stepping
      } else if (/^\d+-\d+$/.test(rangePart)) {
        const [a, b] = rangePart.split("-").map(Number);
        lo = a;
        hi = b;
      } else {
        fail("cron_range_invalid");
      }
      if (lo > hi) fail("cron_range_invalid");
      if (lo < 0 || hi > max) fail("cron_range_out_of_bounds");
      for (let v = lo; v <= hi; v += step) values.add(v);
    }
    return { values, name };
  });
  let dowValues = sets[4].values;
  if (dowValues.has(7)) {
    dowValues = new Set(dowValues);
    dowValues.delete(7);
    dowValues.add(0);
  }
  return {
    minutes: [...sets[0].values].sort((a, b) => a - b),
    hours: [...sets[1].values].sort((a, b) => a - b),
    doms: [...sets[2].values].sort((a, b) => a - b),
    months: [...sets[3].values].sort((a, b) => a - b),
    dows: [...dowValues].sort((a, b) => a - b),
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

/** Classic cron day matching: when BOTH day-of-month and day-of-week are
 *  restricted, a day matches if EITHER matches; otherwise both must match. */
function cronDayMatches(sets: CronSets, day: Date): boolean {
  const domMatch = sets.doms.includes(day.getDate());
  const dowMatch = sets.dows.includes(day.getDay());
  if (sets.domRestricted && sets.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Next local time STRICTLY AFTER `from` matching the cron expression.
 *  Searches at most ~4 years out (covers Feb-29-only schedules); returns null
 *  if none found (e.g. `0 0 30 2 *`). */
export function nextCronRunAfter(expr: string, from: Date): Date | null {
  const sets = parseCron(expr);
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let d = 0; d < 1462; d++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d);
    if (!sets.months.includes(day.getMonth() + 1)) continue;
    if (!cronDayMatches(sets, day)) continue;
    for (const h of sets.hours) {
      for (const m of sets.minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        if (at.getTime() > from.getTime()) return at;
      }
    }
  }
  return null;
}

/** Next run (strictly after `from`) for any spec. Interval schedules are
 *  relative to `from`; cron-based ones resolve to the next matching wall time. */
export function nextRunAfter(spec: ScheduleSpec, from: Date): Date | null {
  if (spec.kind === "interval") {
    return new Date(from.getTime() + intervalMs(spec));
  }
  if (spec.kind === "manual") return null;
  return nextCronRunAfter(scheduleToCron(spec), from);
}

/* ─────────────────────────── humanize ─────────────────────────── */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** English human description (server side; the UI renders its own localized
 *  strings from the spec parts). */
export function humanizeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "interval": {
      const n = spec.every;
      const unit = n === 1 ? spec.unit.slice(0, -1) : spec.unit;
      return `Every ${n} ${unit}`;
    }
    case "daily":
      return `Daily at ${pad(spec.hour)}:${pad(spec.minute)}`;
    case "weekdays":
      return `Weekdays at ${pad(spec.hour)}:${pad(spec.minute)}`;
    case "weekly":
      return `${[...spec.weekdays].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(", ")} at ${pad(spec.hour)}:${pad(spec.minute)}`;
    case "cron":
      return `Cron: ${spec.expr}`;
    case "manual":
      return "Manual launch";
  }
}
