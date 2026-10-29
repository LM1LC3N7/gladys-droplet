// -----------------------------------------------------------------------------
// The water index of one Droplet, built from the volumes it reports. Pure.
//
// The Droplet has no lifetime counter: each state message may carry `volume`,
// the millilitres since its previous report, "small or negative" (pydroplet
// README). The integration adds them up into a net total (kept in /data) and
// publishes it as an index in litres. The rules, from the guard of the
// lifetime counters (gladys-span-panel src/guard.js, approved at r3, and the
// lessons of the lot 17-18 reviews), turned to an index built here:
// - 0 (or below) is never published; a value below the last one published is
//   never published either: a negative report lowers the net total, and the
//   index stays where it was until the net climbs back above it (status note
//   past 1 L). A drop of a built index is never accepted, not even by a click;
// - a report larger than what 200 L/min bring in the time since the previous
//   report (capped to 10 min) plus 10 L is not counted by itself: positive, it
//   is HELD (shown in the status, kept in /data, never confirmed by time nor
//   by repetition) until the user accepts it; negative, it is ignored
//   (counted in the status). The reports after it count as usual: a report
//   held never freezes the index;
// - the acceptance is BOUNDED to what was listed at the first click: litres
//   held after the list stay held (src/app.js acceptHeld);
// - the Gladys device may already hold a larger index than /data (/data lost
//   or restored from an old copy): the index goes on from Gladys's value,
//   never below it.
// The net total is kept in mL, rounded to 0.001 mL at each report (no drift of
// floating sums); the index is published in L, rounded DOWN to the mL.
// -----------------------------------------------------------------------------

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const roundMl = (ml) => Math.round(ml * 1000) / 1000;

const validLast = (last) =>
  last && finite(last.value) && last.value > 0 && finite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

const validHeld = (held) =>
  held &&
  finite(held.ml) &&
  held.ml > 0 &&
  Number.isInteger(held.count) &&
  held.count > 0 &&
  finite(held.at)
    ? { ml: held.ml, count: Math.min(held.count, 1_000_000), at: held.at }
    : undefined;

const validIgnored = (ignored) =>
  ignored && Number.isInteger(ignored.count) && ignored.count > 0 && finite(ignored.ml)
    ? { count: Math.min(ignored.count, 1_000_000), ml: Math.abs(ignored.ml) }
    : undefined;

export class WaterIndex {
  /**
   * `saved`: the state kept in /data (`state()`), when there is one.
   * `gladysLast`: the index the Gladys device holds (`{ value (L), at }`).
   * `limits`: `{ maxLpm, slackL, maxGapMs }` (src/constants.js VOLUME_LIMITS).
   */
  constructor({ saved, gladysLast, limits }) {
    if (!(limits?.maxLpm > 0) || !(limits.slackL >= 0) || !(limits.maxGapMs > 0)) {
      throw new TypeError('WaterIndex needs { maxLpm, slackL, maxGapMs }');
    }
    this.limits = limits;
    const kept = validLast(saved?.last);
    const known = validLast(gladysLast);
    /** The last value published (L), never lowered. */
    this.last = kept && (!known || kept.value >= known.value) ? kept : known;
    /** The net total of the volumes counted, in mL (may sit below `last` after negative reports). */
    this.net = finite(saved?.net) ? roundMl(saved.net) : 0;
    if (known && (!kept || known.value > kept.value)) {
      // Gladys holds more than /data: what came between is not known; the
      // index goes on from Gladys's value.
      this.net = Math.max(this.net, known.value * 1000);
    }
    /** Positive reports too large to be counted: `{ ml, count, at }`. */
    this.held = validHeld(saved?.held);
    /** Negative reports too large: `{ count, ml }` (shown, never counted). */
    this.ignored = validIgnored(saved?.ignored);
  }

  /** The largest volume (mL) that may come `elapsed` ms after the previous report. */
  bound(elapsed) {
    const ms = Math.min(Math.max(0, elapsed), this.limits.maxGapMs);
    return (this.limits.maxLpm * ms) / 60 + this.limits.slackL * 1000;
  }

  /**
   * One report of `ml` millilitres, `elapsed` ms after the previous one, at
   * `at` (session clock). Returns 'counted' | 'held' | 'ignored'.
   */
  add(ml, elapsed, at) {
    if (!finite(ml)) return 'ignored';
    if (Math.abs(ml) <= this.bound(elapsed)) {
      this.net = roundMl(this.net + ml);
      return 'counted';
    }
    if (ml > 0) {
      this.held = this.held
        ? { ml: roundMl(this.held.ml + ml), count: this.held.count + 1, at: this.held.at }
        : { ml: roundMl(ml), count: 1, at };
      return 'held';
    }
    this.ignored = {
      count: (this.ignored?.count ?? 0) + 1,
      ml: roundMl((this.ignored?.ml ?? 0) - ml),
    };
    return 'ignored';
  }

  /** Another index of the same Droplet, built while this one could not be used: added to it. */
  merge(other) {
    this.net = roundMl(this.net + other.net);
    if (other.held) {
      this.held = this.held
        ? {
            ml: roundMl(this.held.ml + other.held.ml),
            count: this.held.count + other.held.count,
            at: Math.min(this.held.at, other.held.at),
          }
        : { ...other.held };
    }
    if (other.ignored) {
      this.ignored = {
        count: (this.ignored?.count ?? 0) + other.ignored.count,
        ml: roundMl((this.ignored?.ml ?? 0) + other.ignored.ml),
      };
    }
  }

  /** The net total in L, rounded down to the mL. */
  netLitres() {
    return Math.floor(this.net) / 1000;
  }

  /**
   * The value to publish now (L), or undefined when there is none yet (a net
   * of 0 or below, never published). Never below the last one published: a
   * value above it becomes the last one.
   */
  take(at) {
    const value = this.netLitres();
    if (this.last && value <= this.last.value) return this.last.value;
    if (!(value > 0)) return undefined;
    this.last = { value, at };
    return value;
  }

  /** How far (L) the net total sits below the index published (negative reports). */
  shortfall() {
    return this.last ? Math.max(0, this.last.value - this.netLitres()) : 0;
  }

  /**
   * The user accepts `ml` of what is held (the amount listed at the first
   * click, never more). Returns the litres added, or 0 when the held volume
   * is no longer at least that.
   */
  acceptHeld(ml) {
    if (!this.held || !finite(ml) || ml <= 0 || this.held.ml + 1e-6 < ml) return 0;
    this.net = roundMl(this.net + ml);
    const rest = roundMl(this.held.ml - ml);
    this.held = rest > 0.0005 ? { ...this.held, ml: rest } : undefined;
    return ml / 1000;
  }

  /** What /data keeps. */
  state() {
    return {
      net: this.net,
      last: this.last ?? null,
      held: this.held ?? null,
      ignored: this.ignored ?? null,
    };
  }
}
