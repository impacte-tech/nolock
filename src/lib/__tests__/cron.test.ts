// ---------------------------------------------------------------------------
// Unit tests for the minimal 5-field cron matcher (src/lib/cron.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, describeCron } from "../cron";

describe("parseCron", () => {
  it("parses a 5-field expression", () => {
    const c = parseCron("0 9 * * 1-5");
    expect(c.minute.values.has(0)).toBe(true);
    expect(c.hour.values.has(9)).toBe(true);
    expect(c.dayOfMonth.wildcard).toBe(true);
    expect(c.dayOfWeek.values.has(1)).toBe(true);
    expect(c.dayOfWeek.values.has(5)).toBe(true);
    expect(c.dayOfWeek.values.has(0)).toBe(false);
    expect(c.raw).toBe("0 9 * * 1-5");
  });

  it("parses steps, lists, and ranges", () => {
    const c = parseCron("*/15 9,10 1-5 6 *");
    expect(c.minute.values.size).toBe(4); // 0,15,30,45
    expect(c.minute.values.has(15)).toBe(true);
    expect(c.hour.values.has(9)).toBe(true);
    expect(c.hour.values.has(10)).toBe(true);
    expect(c.hour.values.has(11)).toBe(false);
    expect(c.dayOfMonth.values.has(1)).toBe(true);
    expect(c.dayOfMonth.values.has(5)).toBe(true);
    expect(c.dayOfMonth.values.has(6)).toBe(false);
    expect(c.month.values.has(6)).toBe(true);
    expect(c.month.values.has(7)).toBe(false);
  });

  it("throws on wrong number of fields", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/5 fields/);
    expect(() => parseCron("")).toThrow(/5 fields/);
    expect(() => parseCron("0 9 * * * *")).toThrow(/5 fields/);
  });
});

describe("cronMatches", () => {
  const at = (d: string, t: string) => new Date(`${d}T${t}:00`);

  it("matches daily at the given time", () => {
    expect(cronMatches("0 9 * * *", at("2026-08-01", "09:00"))).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-08-01", "10:00"))).toBe(false);
  });

  it("matches step expressions (every 15 minutes)", () => {
    const c = parseCron("*/15 * * * *");
    expect(cronMatches(c, at("2026-08-01", "09:00"))).toBe(true);
    expect(cronMatches(c, at("2026-08-01", "09:15"))).toBe(true);
    expect(cronMatches(c, at("2026-08-01", "09:30"))).toBe(true);
    expect(cronMatches(c, at("2026-08-01", "09:07"))).toBe(false);
  });

  it("matches lists and ranges", () => {
    expect(cronMatches("1,3,5 * * * *", at("2026-08-01", "09:03"))).toBe(true);
    expect(cronMatches("1,3,5 * * * *", at("2026-08-01", "09:04"))).toBe(false);
    expect(cronMatches("0 9-17 * * *", at("2026-08-01", "12:00"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at("2026-08-01", "18:00"))).toBe(false);
  });

  it("honors day-of-month / day-of-week OR semantics", () => {
    // 9am on the 15th OR on a Monday.
    const c = parseCron("0 9 15 * 1");
    // 2026-08-03 is a Monday.
    expect(cronMatches(c, at("2026-08-03", "09:00"))).toBe(true);
    // 15th of August (a Saturday).
    expect(cronMatches(c, at("2026-08-15", "09:00"))).toBe(true);
    // 20th of August (a Thursday) — neither.
    expect(cronMatches(c, at("2026-08-20", "09:00"))).toBe(false);
  });

  it("accepts string expressions directly", () => {
    expect(cronMatches("0 9 * * *", at("2026-08-01", "09:00"))).toBe(true);
  });
});

describe("describeCron", () => {
  it("describes simple expressions", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeCron("0 9 * * 1-5")).toBe("Every Mon, Tue, Wed, Thu, Fri at 09:00");
  });

  it("returns undefined for expressions too complex to describe", () => {
    expect(describeCron("*/5 * * * *")).toBeUndefined();
    expect(describeCron("not a cron")).toBeUndefined();
  });
});
