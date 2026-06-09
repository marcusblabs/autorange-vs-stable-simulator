/**
 * Cost model: turn per-book slippage into an all-in USD cost (slippage + swap
 * fee + gas), find the break-even trade size, and fit an AutoRange band to a
 * Stable pool. The swap fee is already inside each book's quote (Balancer takes
 * it on the input), so "all-in" here only adds gas on top of the priced
 * slippage. All arithmetic is BigNumber.
 */
import { BigNumber, type BN } from './numeric';
import {
  makeStableBook,
  makeReClammBook,
  type Book,
  type ReClammBook,
  type Dir,
  type Quote,
} from './pools';

/** Gas cost of one swap in USD = units × gwei × 1e-9 × ETH price. */
export function gasUsd(units: BN, gwei: BN, ethUsd: BN): BN {
  if (units.gt(0) && gwei.gt(0) && ethUsd.gt(0)) {
    return units.times(gwei).times('1e-9').times(ethUsd);
  }
  return new BigNumber(0);
}

/** USD price of one unit of the sold token. */
function inputPriceUsd(dir: Dir, r: BN, priceY: BN): BN {
  return dir === 'xy' ? r.times(priceY) : priceY;
}

export interface CostCtx {
  stable: Book;
  ar: ReClammBook;
  dir: Dir;
  r: BN;
  priceY: BN; // USD price of the quote token (1 for $-stables)
  gasS: BN; // USD gas for a Stable swap
  gasA: BN; // USD gas for an AutoRange swap
}

export interface Metrics {
  a: BN;
  notional: BN; // USD value of the trade
  s: Quote;
  ar: Quote;
  sAll: BN; // Stable all-in USD cost
  aAll: BN | null; // AutoRange all-in USD cost (null = band exhausted)
  sPct: BN; // all-in as a fraction of notional
  aPct: BN;
}

/** Per-book metrics at trade size `a`. */
export function evalAt(ctx: CostCtx, a: BN): Metrics {
  const notional = a.times(inputPriceUsd(ctx.dir, ctx.r, ctx.priceY));
  const s = ctx.stable.quote(ctx.dir, a);
  const ar = ctx.ar.quote(ctx.dir, a);
  const sAll = s.slippage.times(notional).plus(ctx.gasS);
  const aAll = ar.exhausted ? null : ar.slippage.times(notional).plus(ctx.gasA);
  return {
    a,
    notional,
    s,
    ar,
    sAll,
    aAll,
    sPct: notional.gt(0) ? sAll.div(notional) : new BigNumber(0),
    aPct: notional.gt(0) && aAll !== null ? aAll.div(notional) : new BigNumber(1),
  };
}

/**
 * Trade size where both books' all-in USD cost is equal (within the AR band).
 * Returns null when one book is cheaper across the whole range.
 */
export function findBreakEven(ctx: CostCtx, edge: BN): BN | null {
  const lo = BigNumber.max(edge.times('1e-4'), new BigNumber('1e-9'));
  const hi = edge.times('0.999');
  if (!hi.gt(lo)) return null;

  // f(a) = AR all-in − Stable all-in; null AR cost = no comparison possible.
  const f = (a: BN): BN | null => {
    const m = evalAt(ctx, a);
    return m.aAll === null ? null : m.aAll.minus(m.sAll);
  };

  let flo = f(lo);
  const fhi = f(hi);
  if (flo === null || fhi === null) return null;
  if (flo.isZero()) return lo;
  if (flo.times(fhi).gt(0)) return null; // same sign → no crossover

  let a = lo;
  let b = hi;
  for (let i = 0; i < 64; i++) {
    const m = a.plus(b).div(2);
    const fm = f(m);
    if (fm === null) break;
    if (fm.isZero()) return m;
    if (fm.gt(0) === flo.gt(0)) {
      a = m;
      flo = fm;
    } else {
      b = m;
    }
  }
  return a.plus(b).div(2);
}

// ---------------------------------------------------------------------------
// Fit an AutoRange band so its all-in cost matches Stable at a target size.
// ---------------------------------------------------------------------------

export interface FitInput {
  V: BN;
  r: BN;
  A: BN;
  feeS: BN; // fraction
  feeA: BN; // fraction
  dir: Dir;
  priceY: BN;
  gasS: BN;
  gasA: BN;
  target: BN;
}

export interface FitResult {
  kind: 'matched' | 'stable-cheaper' | 'ar-cheaper' | 'infeasible';
  message: string;
  w?: BN; // chosen half-width (fraction)
  Pa?: BN;
  Pb?: BN;
  sAll?: BN;
}

/**
 * Solve for the band half-width w (band = [r(1−w), r(1+w)]) whose AutoRange
 * all-in cost equals the Stable all-in cost at `target`. Within the
 * non-exhausting region, AR all-in increases with w, so it's a clean bisection.
 */
export function fitBand(inp: FitInput): FitResult {
  const { V, r, A, feeS, feeA, dir, priceY, gasS, gasA, target } = inp;
  if (!(r.gt(0) && A.gt(0) && V.gt(0) && target.gt(0))) {
    return { kind: 'infeasible', message: 'Need valid rate, A, value and a target size.' };
  }
  const stable = makeStableBook(V, r, A, feeS);
  if (!stable) return { kind: 'infeasible', message: 'Could not build the Stable book.' };

  const notional = target.times(inputPriceUsd(dir, r, priceY));
  const sAll = stable.quote(dir, target).slippage.times(notional).plus(gasS);

  // AR all-in as a function of half-width w; null = band exhausts at target.
  const arAllAt = (w: BN): BN | null => {
    const Pa = r.times(new BigNumber(1).minus(w));
    const Pb = r.times(new BigNumber(1).plus(w));
    const book = makeReClammBook(V, r, Pa, Pb, feeA);
    if (!book) return null;
    const q = book.quote(dir, target);
    if (q.exhausted) return null;
    return q.slippage.times(notional).plus(gasA);
  };

  // Smallest w that doesn't exhaust at the target (feasibility grows with w).
  let lo = new BigNumber('1e-5');
  let hi = new BigNumber('0.99');
  for (let i = 0; i < 60; i++) {
    const m = lo.plus(hi).div(2);
    if (arAllAt(m) !== null) hi = m;
    else lo = m;
  }
  const wMin = hi;
  const fMin = arAllAt(wMin.times('1.0001'));
  if (fMin === null) {
    return {
      kind: 'infeasible',
      message: 'No feasible band at this size — trade exceeds AR capacity for any width near the rate.',
    };
  }
  if (fMin.gt(sAll)) {
    const wTight = wMin.times('1.05');
    return {
      kind: 'stable-cheaper',
      w: wTight,
      Pa: r.times(new BigNumber(1).minus(wTight)),
      Pb: r.times(new BigNumber(1).plus(wTight)),
      message:
        'Stable is cheaper than any non-exhausting AR band at this size. Set to tightest feasible (±' +
        wMin.times(100).toFixed(3) + '%).',
    };
  }

  let a = wMin.times('1.0001');
  let b = new BigNumber('0.99');
  const fbVal = arAllAt(b);
  if (fbVal !== null && fbVal.minus(sAll).lt(0)) {
    return {
      kind: 'ar-cheaper',
      message: 'AutoRange is cheaper than Stable across feasible widths; band left as-is.',
    };
  }
  let fa = (arAllAt(a) ?? sAll).minus(sAll);
  for (let i = 0; i < 64; i++) {
    const m = a.plus(b).div(2);
    const v = arAllAt(m);
    if (v === null) {
      b = m;
      continue;
    }
    const fm = v.minus(sAll);
    if (fm.isZero()) {
      a = m;
      b = m;
      break;
    }
    if (fm.gt(0) === fa.gt(0)) {
      a = m;
      fa = fm;
    } else {
      b = m;
    }
  }
  const w = a.plus(b).div(2);
  return {
    kind: 'matched',
    w,
    Pa: r.times(new BigNumber(1).minus(w)),
    Pb: r.times(new BigNumber(1).plus(w)),
    sAll,
    message:
      'Band ±' + w.times(100).toFixed(4) + '% matches Stable all-in ($' +
      sAll.toFixed(2) + ') at target size.',
  };
}
