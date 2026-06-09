/**
 * Numeric core.
 *
 * Every calculation in this app runs through bignumber.js at full precision.
 * The ONLY place numbers are narrowed to a few decimal places is at display
 * time (the `smart` / `fmt` / `pct` helpers below). The balancer-maths engine
 * works in 18-decimal fixed-point BigInt internally — which is also full
 * precision — so the BigNumber <-> scaled18-BigInt boundary is the single seam
 * where we move between the two exact representations.
 */
import BigNumber from 'bignumber.js';

// Plenty of guard digits for sqrt/pow and the Newton-style solvers downstream.
BigNumber.config({ DECIMAL_PLACES: 60, POW_PRECISION: 80, EXPONENTIAL_AT: [-40, 60] });

export { BigNumber };
export type BN = BigNumber;
export type BNIn = BigNumber.Value; // number | string | BigNumber

export const BN = (v: BNIn): BigNumber => new BigNumber(v);
export const ZERO = new BigNumber(0);
export const ONE = new BigNumber(1);

/** 1e18 as a BigNumber — the scaled-18 fixed-point unit (WAD). */
export const WAD_BN = new BigNumber('1e18');
/** 1e18 as a BigInt — what balancer-maths uses for a rate/fee of 1.0. */
export const WAD = 10n ** 18n;

/** A finite, parseable BigNumber? */
export function ok(v: BNIn | null | undefined): v is BNIn {
  if (v === null || v === undefined) return false;
  const b = new BigNumber(v);
  return b.isFinite();
}

/** Read a number-ish input value as a BigNumber (NaN -> null). */
export function readBN(value: string): BigNumber | null {
  if (value == null || value.trim() === '') return null;
  const b = new BigNumber(value);
  return b.isFinite() ? b : null;
}

// ---------------------------------------------------------------------------
// BigNumber <-> scaled-18 BigInt (the balancer-maths boundary)
// ---------------------------------------------------------------------------

/** BigNumber (whole-token units) -> 18-decimal fixed-point BigInt, rounded. */
export function toScaled18(v: BNIn): bigint {
  return BigInt(new BigNumber(v).times(WAD_BN).integerValue(BigNumber.ROUND_HALF_UP).toFixed(0));
}

/** 18-decimal fixed-point BigInt -> BigNumber (whole-token units), exact. */
export function fromScaled18(x: bigint): BigNumber {
  return new BigNumber(x.toString()).div(WAD_BN);
}

// ---------------------------------------------------------------------------
// Display formatting — the one place we drop precision, for humans only.
// ---------------------------------------------------------------------------

const EM_DASH = '—';

/** Locale number with `d` max fraction digits. Accepts BigNumber or number. */
export function fmt(n: BNIn | null | undefined, d: number): string {
  if (n == null) return EM_DASH;
  const b = new BigNumber(n);
  if (!b.isFinite()) return EM_DASH;
  // Round at full precision, then hand a plain number to toLocaleString only
  // for digit-grouping. Values here are already display-scale (small d).
  return Number(b.toFixed(d)).toLocaleString('en-US', {
    maximumFractionDigits: d,
    minimumFractionDigits: 0,
  });
}

/** Adaptive precision for a single value (more digits as magnitude shrinks). */
export function smart(n: BNIn | null | undefined): string {
  if (n == null) return EM_DASH;
  const b = new BigNumber(n);
  if (!b.isFinite()) return EM_DASH;
  const a = b.abs();
  if (a.isZero()) return '0';
  if (a.gte(1000)) return fmt(b, 0);
  if (a.gte(1)) return fmt(b, 3);
  if (a.gte(0.01)) return fmt(b, 4);
  return fmt(b, 6);
}

/** Format a fraction (e.g. 0.0123) as a percentage string. */
export function pct(n: BNIn | null | undefined): string {
  if (n == null) return EM_DASH;
  const b = new BigNumber(n);
  if (!b.isFinite()) return EM_DASH;
  const a = b.abs().times(100);
  if (a.isZero()) return '0%';
  if (a.lt(0.001)) return '<0.001%';
  if (a.lt(1)) return a.toFixed(3) + '%';
  if (a.lt(10)) return a.toFixed(2) + '%';
  return a.toFixed(1) + '%';
}
