/**
 * Day arithmetic in pure UTC. Every statutory deadline and every rollup bucket is a *calendar
 * day*, not an instant, so doing this with `Date` objects and local time zones is how off-by-one
 * bugs get into a legal deadline. Days are integers; conversion happens at the edges only.
 */

const MS_PER_DAY = 86_400_000;

/** Days since the Unix epoch for a `YYYY-MM-DD` string. Throws on a malformed date. */
export function dayNumber(isoDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new RangeError(`not an ISO date: ${isoDate}`);
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(ms)) throw new RangeError(`not an ISO date: ${isoDate}`);
  const back = new Date(ms);
  // Date.UTC silently rolls 2025-02-30 into March; reject rather than accept a wrong deadline.
  if (back.getUTCMonth() !== Number(mo) - 1 || back.getUTCDate() !== Number(d)) {
    throw new RangeError(`not a real calendar date: ${isoDate}`);
  }
  return Math.floor(ms / MS_PER_DAY);
}

export function fromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return fromDayNumber(dayNumber(isoDate) + days);
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC day a timestamp falls in — the rollup bucket key. */
export function dayOf(isoDateTime: string): string {
  return new Date(isoDateTime).toISOString().slice(0, 10);
}
