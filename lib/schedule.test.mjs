import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  humanizeSchedule,
  nextCronRunAfter,
  nextRunAfter,
  parseCron,
  scheduleToCron,
  ScheduleValidationError,
  validateSchedule,
} = await jiti.import("./schedule.ts");

/** Local-time `from` for deterministic assertions in any TZ. */
function at(y, mo, d, h, mi, s = 0) {
  return new Date(y, mo - 1, d, h, mi, s, 0);
}

function expectCronError(expr, code) {
  try {
    parseCron(expr);
    assert.fail(`expected ${code} for "${expr}"`);
  } catch (err) {
    assert.ok(err instanceof ScheduleValidationError, `expected ScheduleValidationError, got ${err}`);
    assert.equal(err.code, code);
  }
}

test("parseCron: basic, steps, ranges, lists", () => {
  const basic = parseCron("0 9 * * *");
  assert.deepEqual(basic.minutes, [0]);
  assert.deepEqual(basic.hours, [9]);
  assert.equal(basic.domRestricted, false);
  assert.equal(basic.dowRestricted, false);

  const stepped = parseCron("*/15 * * * *");
  assert.deepEqual(stepped.minutes, [0, 15, 30, 45]);

  const ranged = parseCron("0 9-17/2 * * *");
  assert.deepEqual(ranged.hours, [9, 11, 13, 15, 17]);

  const listed = parseCron("0,30 8,20 * * 1,3,5");
  assert.deepEqual(listed.minutes, [0, 30]);
  assert.deepEqual(listed.hours, [8, 20]);
  assert.deepEqual(listed.dows, [1, 3, 5]);
  assert.equal(listed.dowRestricted, true);

  // `N/step` = N through max, stepping.
  const fromStep = parseCron("5/10 * * * *");
  assert.deepEqual(fromStep.minutes, [5, 15, 25, 35, 45, 55]);

  // Day-of-week 7 is Sunday (0).
  const seven = parseCron("0 0 * * 7");
  assert.deepEqual(seven.dows, [0]);
});

test("parseCron: rejects malformed expressions", () => {
  expectCronError("0 9 * *", "cron_fields_5");
  expectCronError("60 * * * *", "cron_range_out_of_bounds");
  expectCronError("* 24 * * *", "cron_range_out_of_bounds");
  expectCronError("* * 32 * *", "cron_range_out_of_bounds");
  expectCronError("* * * 13 *", "cron_range_out_of_bounds");
  expectCronError("* * * * 8", "cron_range_out_of_bounds");
  expectCronError("* * * *", "cron_fields_5");
  expectCronError("a b c d e", "cron_range_invalid");
  expectCronError("*/0 * * * *", "cron_step_invalid");
  expectCronError("5-1 * * * *", "cron_range_invalid");
  expectCronError("1,,2 * * * *", "cron_field_empty");
});

test("nextCronRunAfter: daily, strictly-after, weekly", () => {
  // Before today's 09:00 → today 09:00.
  assert.deepEqual(nextCronRunAfter("0 9 * * *", at(2026, 9, 5, 8, 0)), at(2026, 9, 5, 9, 0));
  // Exactly at 09:00 → tomorrow (strictly after).
  assert.deepEqual(nextCronRunAfter("0 9 * * *", at(2026, 9, 5, 9, 0)), at(2026, 9, 6, 9, 0));
  // After 09:00 → tomorrow.
  assert.deepEqual(nextCronRunAfter("0 9 * * *", at(2026, 9, 5, 9, 0, 30)), at(2026, 9, 6, 9, 0));

  // 2026-09-04 is a Friday; next Monday is 2026-09-07.
  assert.deepEqual(nextCronRunAfter("0 9 * * 1", at(2026, 9, 4, 12, 0)), at(2026, 9, 7, 9, 0));
});

test("nextCronRunAfter: day-of-month OR day-of-week when both restricted", () => {
  // `0 9 13 * 5` = the 13th OR a Friday. From Friday 2026-09-04 08:00 the
  // same-day 09:00 matches via dow.
  assert.deepEqual(nextCronRunAfter("0 9 13 * 5", at(2026, 9, 4, 8, 0)), at(2026, 9, 4, 9, 0));
  // From Saturday 2026-09-05: next match is Friday 2026-09-11 (before the 13th).
  assert.deepEqual(nextCronRunAfter("0 9 13 * 5", at(2026, 9, 5, 12, 0)), at(2026, 9, 11, 9, 0));
});

test("nextCronRunAfter: rare and impossible dates", () => {
  // Feb 29 next after 2026-01-01 is 2028-02-29 (2026/2027 not leap).
  assert.deepEqual(nextCronRunAfter("0 0 29 2 *", at(2026, 1, 1, 0, 0)), at(2028, 2, 29, 0, 0));
  // Feb 30 never exists.
  assert.equal(nextCronRunAfter("0 0 30 2 *", at(2026, 1, 1, 0, 0)), null);
});

test("scheduleToCron: spec conversion", () => {
  assert.equal(scheduleToCron({ kind: "daily", hour: 9, minute: 30 }), "30 9 * * *");
  assert.equal(scheduleToCron({ kind: "weekdays", hour: 9, minute: 30 }), "30 9 * * 1-5");
  assert.equal(scheduleToCron({ kind: "weekly", hour: 9, minute: 30, weekdays: [3, 1] }), "30 9 * * 1,3");
  assert.equal(scheduleToCron({ kind: "cron", expr: "*/5 * * * *" }), "*/5 * * * *");
  assert.throws(() => scheduleToCron({ kind: "interval", every: 5, unit: "minutes" }), /interval_not_cron/);
  assert.throws(() => scheduleToCron({ kind: "manual" }), /manual_not_cron/);
});

test("nextRunAfter: interval schedules are relative", () => {
  const from = at(2026, 9, 5, 12, 0);
  assert.deepEqual(nextRunAfter({ kind: "interval", every: 30, unit: "minutes" }, from), at(2026, 9, 5, 12, 30));
  assert.deepEqual(nextRunAfter({ kind: "interval", every: 2, unit: "hours" }, from), at(2026, 9, 5, 14, 0));
  assert.deepEqual(nextRunAfter({ kind: "interval", every: 1, unit: "days" }, from), at(2026, 9, 6, 12, 0));
});

test("manual kind: valid, never auto-fires, humanized", () => {
  assert.deepEqual(validateSchedule({ kind: "manual" }), { kind: "manual" });
  // The load-bearing contract: a manual schedule has no next run, so the
  // engine's tick never fires it — it can only run on demand.
  assert.equal(nextRunAfter({ kind: "manual" }, at(2026, 9, 5, 12, 0)), null);
  assert.equal(humanizeSchedule({ kind: "manual" }), "Manual launch");
});

test("validateSchedule: accepts valid specs, rejects with stable codes", () => {
  assert.deepEqual(validateSchedule({ kind: "daily", hour: 0, minute: 0 }), { kind: "daily", hour: 0, minute: 0 });
  assert.deepEqual(validateSchedule({ kind: "interval", every: 1, unit: "minutes" }), { kind: "interval", every: 1, unit: "minutes" });
  // weekly dedupes + sorts its days.
  assert.deepEqual(validateSchedule({ kind: "weekly", hour: 1, minute: 1, weekdays: [5, 1, 5] }), {
    kind: "weekly",
    hour: 1,
    minute: 1,
    weekdays: [1, 5],
  });
  assert.deepEqual(validateSchedule({ kind: "cron", expr: " 0 9 * * 1 " }), { kind: "cron", expr: "0 9 * * 1" });

  const cases = [
    [null, "schedule_required"],
    [{ kind: "hourly" }, "schedule_kind_invalid"],
    [{ kind: "interval", every: 0, unit: "minutes" }, "schedule_every_out_of_range"],
    [{ kind: "interval", every: 61, unit: "days" }, "schedule_every_out_of_range"],
    [{ kind: "interval", every: 5, unit: "weeks" }, "schedule_unit_invalid"],
    [{ kind: "daily", hour: 24, minute: 0 }, "schedule_time_invalid"],
    [{ kind: "daily", hour: 9, minute: 60 }, "schedule_time_invalid"],
    [{ kind: "weekly", hour: 9, minute: 0, weekdays: [] }, "schedule_weekdays_required"],
    [{ kind: "weekly", hour: 9, minute: 0, weekdays: [7] }, "schedule_weekdays_invalid"],
    [{ kind: "cron", expr: "" }, "schedule_cron_required"],
    [{ kind: "cron", expr: "0 9 * *" }, "cron_fields_5"],
  ];
  for (const [spec, code] of cases) {
    try {
      validateSchedule(spec);
      assert.fail(`expected ${code} for ${JSON.stringify(spec)}`);
    } catch (err) {
      assert.ok(err instanceof ScheduleValidationError, `expected ScheduleValidationError for ${JSON.stringify(spec)}, got ${err}`);
      assert.equal(err.code, code);
    }
  }
});

test("humanizeSchedule: readable descriptions", () => {
  assert.equal(humanizeSchedule({ kind: "interval", every: 30, unit: "minutes" }), "Every 30 minutes");
  assert.equal(humanizeSchedule({ kind: "interval", every: 2, unit: "hours" }), "Every 2 hours");
  assert.equal(humanizeSchedule({ kind: "daily", hour: 9, minute: 5 }), "Daily at 09:05");
  assert.equal(humanizeSchedule({ kind: "weekdays", hour: 9, minute: 0 }), "Weekdays at 09:00");
  assert.equal(humanizeSchedule({ kind: "weekly", hour: 9, minute: 0, weekdays: [1, 3, 5] }), "Mon, Wed, Fri at 09:00");
  assert.equal(humanizeSchedule({ kind: "cron", expr: "0 9 * * *" }), "Cron: 0 9 * * *");
  assert.equal(humanizeSchedule({ kind: "manual" }), "Manual launch");
});
