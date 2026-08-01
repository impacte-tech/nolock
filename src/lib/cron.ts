// ---------------------------------------------------------------------------
// Minimal 5-field cron matcher — no external dependency.
//
// Supports the standard cron fields:
//   minute hour day-of-month month day-of-week
// with `*`, `*/n` (step), `a-b` (range), `a,b` (list), and `a-b/n` (range +
// step). day-of-month and day-of-week use "OR" semantics like standard cron:
// if either is restricted (non-`*`), a date matches when *either* field is
// satisfied.
// ---------------------------------------------------------------------------

export interface CronField {
  /** Every value the field allows (0-based for minute/hour/month/weekday). */
  values: Set<number>;
  /** True when the field is `*` (unrestricted). */
  wildcard: boolean;
}

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  /** The raw expression string that produced this object. */
  raw: string;
}

/**
 * Expand a single cron field segment (e.g. "1-5", "1,3,5", "*", or a step
 * pattern like a star followed by "/15") into the set of allowed values
 * within [min, max].
 */
function expandSegment(segment: string, min: number, max: number): Set<number> {
  const values = new Set<number>();

  const apply = (lo: number, hi: number, step: number) => {
    let v = lo;
    while (v <= hi) {
      values.add(v);
      v += step;
    }
  };

  for (const part of segment.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;

    let step = 1;
    let rangePart = trimmed;
    if (trimmed.includes("/")) {
      const slashIdx = trimmed.indexOf("/");
      const stepStr = trimmed.slice(slashIdx + 1);
      const n = parseInt(stepStr, 10);
      if (!Number.isNaN(n) && n > 0) step = n;
      rangePart = trimmed.slice(0, slashIdx);
    }

    if (rangePart === "*") {
      apply(min, max, step);
    } else if (rangePart.includes("-")) {
      const dashIdx = rangePart.indexOf("-");
      const lo = parseInt(rangePart.slice(0, dashIdx), 10);
      const hi = parseInt(rangePart.slice(dashIdx + 1), 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) {
        apply(lo, hi, step);
      }
    } else {
      const v = parseInt(rangePart, 10);
      if (!Number.isNaN(v) && v >= min && v <= max) values.add(v);
    }
  }

  return values;
}

function parseField(segment: string, min: number, max: number): CronField {
  const trimmed = (segment || "*").trim();
  const wildcard = trimmed === "*";
  return { values: expandSegment(trimmed, min, max), wildcard };
}

/**
 * Parse a 5-field cron expression. Throws on malformed input.
 */
export function parseCron(expr: string): CronExpression {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields (minute hour day-of-month month day-of-week).`,
    );
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dayOfWeek: parseField(dow, 0, 6),
    raw: expr.trim(),
  };
}

/**
 * Return the cron field for a given date. JS `getDay()` is 0 (Sunday) – 6
 * (Saturday), matching cron's day-of-week numbering.
 */
function fieldsForDate(date: Date): { minute: number; hour: number; dom: number; month: number; dow: number } {
  return {
    minute: date.getMinutes(),
    hour: date.getHours(),
    dom: date.getDate(),
    month: date.getMonth() + 1, // cron months are 1-12
    dow: date.getDay(), // 0 (Sunday) - 6 (Saturday)
  };
}

/**
 * Check whether a date matches a parsed cron expression.
 */
export function cronMatches(expr: CronExpression | string, date: Date): boolean {
  const parsed = typeof expr === "string" ? parseCron(expr) : expr;
  const f = fieldsForDate(date);

  if (!parsed.minute.values.has(f.minute)) return false;
  if (!parsed.hour.values.has(f.hour)) return false;
  if (!parsed.month.values.has(f.month)) return false;

  // Day-of-month / day-of-week OR semantics (standard cron):
  // If both are wildcards, any day matches. If either is restricted, the date
  // matches when either field is satisfied.
  const domMatches = parsed.dayOfMonth.values.has(f.dom);
  const dowMatches = parsed.dayOfWeek.values.has(f.dow);

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  return domMatches || dowMatches;
}

/**
 * Human-readable one-line description of a cron expression (for the creation UI).
 * Returns undefined for expressions that can't be described simply.
 */
export function describeCron(expr: string): string | undefined {
  try {
    const parsed = parseCron(expr);
    if (parsed.minute.wildcard && parsed.hour.wildcard) return "Every minute";
    if (parsed.minute.values.size === 1 && parsed.hour.values.size === 1) {
      const minute = [...parsed.minute.values][0];
      const hour = [...parsed.hour.values][0];
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return `Daily at ${time}`;
      if (parsed.dayOfWeek.values.size >= 1 && parsed.dayOfMonth.wildcard) {
        const days = [...parsed.dayOfWeek.values].sort();
        const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return `Every ${days.map((d) => names[d]).join(", ")} at ${time}`;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
