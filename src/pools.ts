/**
 * Pool math — delegated entirely to @balancer-labs/balancer-maths.
 *
 * We compare two Balancer v3 books on the same pair, same total value V (in Y
 * units), centered on the same rate r (Y per X):
 *
 *  - STABLE  : Balancer StableSwap (the `Stable` pool type). Balanced so each
 *              side holds equal value; the rate is supplied as a token rate so
 *              correlated pairs (wstETH/ETH …) trade as if balanced.
 *  - RECLAMM : Balancer's AutoRange pool (the `ReClamm` pool type) — a
 *              readjusting concentrated-liquidity AMM. We synthesize the pool's
 *              real + virtual balances from a price band [Pa, Pb] so the
 *              constant-product invariant (R + V) gives exactly that band.
 *
 * The reCLAMM recentering / price-shift machinery is disabled by setting
 * lastTimestamp === currentTimestamp, so the band we build is the band that's
 * quoted (no time drift). All construction math is BigNumber; the engine itself
 * is exact 18-decimal fixed point.
 */
import { Vault, SwapKind } from '@balancer-labs/balancer-maths';
import type { StableState, ReClammState } from '@balancer-labs/balancer-maths';
import { BigNumber, WAD, toScaled18, fromScaled18, type BN } from './numeric';

export type Dir = 'xy' | 'yx';

export interface Quote {
  /** Output amount in the bought token (BigNumber, full precision). */
  out: BN;
  /** Fractional slippage vs the ideal (rate-priced) output, e.g. 0.0012. */
  slippage: BN;
  /** Ideal output at the current rate, ignoring curve + fee. */
  ideal: BN;
  /** AutoRange only: band filled, trade cannot complete. */
  exhausted: boolean;
}

export interface Book {
  quote(dir: Dir, amt: BN): Quote;
}

export interface ReClammBook extends Book {
  /** Max input (in the sold token) before the band is exhausted. */
  edge(dir: Dir): BN;
}

// Two sentinel token addresses — index 0 = X (base), index 1 = Y (quote).
const X_ADDR = '0x0000000000000000000000000000000000000001';
const Y_ADDR = '0x0000000000000000000000000000000000000002';

const vault = new Vault();
const ZERO_QUOTE: Quote = {
  out: new BigNumber(0),
  slippage: new BigNumber(0),
  ideal: new BigNumber(0),
  exhausted: false,
};

const pos = (v: BN | null | undefined): v is BN => !!v && v.isFinite() && v.gt(0);

/** Run one exact-in swap through the Vault, in scaled-18, returning the raw out. */
function swap(pool: StableState | ReClammState, dir: Dir, amt: BN): bigint {
  const tokenIn = dir === 'xy' ? X_ADDR : Y_ADDR;
  const tokenOut = dir === 'xy' ? Y_ADDR : X_ADDR;
  return vault.swap(
    { amountRaw: toScaled18(amt), tokenIn, tokenOut, swapKind: SwapKind.GivenIn },
    pool,
  );
}

/** ideal (curve- and fee-free) output for a trade of `amt` at rate r. */
function idealOut(dir: Dir, r: BN, amt: BN): BN {
  return dir === 'xy' ? amt.times(r) : amt.div(r);
}

function quoteFrom(outRaw: bigint, dir: Dir, r: BN, amt: BN): Quote {
  const out = fromScaled18(outRaw);
  const ideal = idealOut(dir, r, amt);
  const slippage = ideal.gt(0) ? ideal.minus(out).div(ideal) : new BigNumber(0);
  return { out, slippage, ideal, exhausted: false };
}

// ---------------------------------------------------------------------------
// STABLE
// ---------------------------------------------------------------------------

/**
 * Build a balanced Balancer StableSwap book of total value V (Y units) at rate
 * r, amplification A and swap fee `feeFrac` (a fraction, e.g. 0.0004).
 *
 * The rate enters as token X's rate, so the live (rate-scaled) balances are
 * equal at V/2 each — the StableSwap "xp" of a balanced pool.
 */
export function makeStableBook(V: BN, r: BN, A: BN, feeFrac: BN): Book | null {
  if (!pos(V) || !pos(r) || !pos(A) || !feeFrac.isFinite() || feeFrac.lt(0)) return null;
  const half = V.div(2);
  const pool: StableState = {
    poolType: 'STABLE',
    poolAddress: X_ADDR,
    tokens: [X_ADDR, Y_ADDR],
    scalingFactors: [1n, 1n], // both synthetic tokens are 18-decimal
    tokenRates: [toScaled18(r), WAD], // 1 X = r Y ; Y is the numeraire
    balancesLiveScaled18: [toScaled18(half), toScaled18(half)],
    swapFee: toScaled18(feeFrac),
    aggregateSwapFee: 0n,
    totalSupply: toScaled18(V),
    supportsUnbalancedLiquidity: true,
    amp: BigInt(A.times(1000).integerValue(BigNumber.ROUND_HALF_UP).toFixed(0)), // AMP_PRECISION = 1000
  };
  return {
    quote(dir, amt) {
      if (!pos(amt)) return ZERO_QUOTE;
      try {
        return quoteFrom(swap(pool, dir, amt), dir, r, amt);
      } catch {
        // Trade beyond what the pool can quote (or sub-dust): treat as no-op.
        return { ...ZERO_QUOTE, ideal: idealOut(dir, r, amt) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// RECLAMM (AutoRange)
// ---------------------------------------------------------------------------

interface Band {
  L: BN;
  Va: BN;
  Vb: BN;
  Ra: BN;
  Rb: BN;
  sP: BN;
  sPa: BN;
  sPb: BN;
  P: BN;
}

/**
 * Concentrated-liquidity geometry for a band [Pa, Pb] centered at price P
 * (clamped into the band), sized to total value V in Y units.
 *
 *   L  = V / (2√P − P/√Pb − √Pa)            (Uniswap-v3 liquidity)
 *   Va = L/√Pb,  Vb = L√Pa                  (reCLAMM virtual balances)
 *   Ra = L(1/√P − 1/√Pb),  Rb = L(√P − √Pa) (real balances)
 *
 * With these, the reCLAMM invariant (Ra+Va)(Rb+Vb) yields minPrice = Pa,
 * maxPrice = Pb and spot = (Rb+Vb)/(Ra+Va) = P.
 */
function band(V: BN, r: BN, Pa: BN, Pb: BN): Band | null {
  if (!pos(V) || !pos(r) || !pos(Pa) || !Pb.gt(Pa)) return null;
  const P = BigNumber.min(BigNumber.max(r, Pa), Pb);
  const sP = P.sqrt();
  const sPa = Pa.sqrt();
  const sPb = Pb.sqrt();
  const D = sP.times(2).minus(P.div(sPb)).minus(sPa);
  if (!D.gt(0)) return null;
  const L = V.div(D);
  return {
    L,
    Va: L.div(sPb),
    Vb: L.times(sPa),
    Ra: L.times(new BigNumber(1).div(sP).minus(new BigNumber(1).div(sPb))),
    Rb: L.times(sP.minus(sPa)),
    sP,
    sPa,
    sPb,
    P,
  };
}

/** Build a Balancer AutoRange (reCLAMM) book for band [Pa, Pb]. */
export function makeReClammBook(V: BN, r: BN, Pa: BN, Pb: BN, feeFrac: BN): ReClammBook | null {
  if (!feeFrac.isFinite() || feeFrac.lt(0)) return null;
  const b = band(V, r, Pa, Pb);
  if (!b) return null;
  const fourthRoot = Pb.div(Pa).sqrt().sqrt(); // (Pb/Pa)^(1/4)
  const pool: ReClammState = {
    poolType: 'RECLAMM',
    poolAddress: X_ADDR,
    tokens: [X_ADDR, Y_ADDR],
    scalingFactors: [1n, 1n],
    tokenRates: [WAD, WAD], // real-price band lives directly in balances
    balancesLiveScaled18: [toScaled18(b.Ra), toScaled18(b.Rb)],
    swapFee: toScaled18(feeFrac),
    aggregateSwapFee: 0n,
    totalSupply: toScaled18(V),
    supportsUnbalancedLiquidity: true,
    lastVirtualBalances: [toScaled18(b.Va), toScaled18(b.Vb)],
    dailyPriceShiftBase: WAD,
    lastTimestamp: 1000n,
    currentTimestamp: 1000n, // == lastTimestamp → no recentering / price shift
    centerednessMargin: 0n,
    startFourthRootPriceRatio: toScaled18(fourthRoot),
    endFourthRootPriceRatio: toScaled18(fourthRoot),
    priceRatioUpdateStartTime: 0n,
    priceRatioUpdateEndTime: 0n,
  };
  const edge = (dir: Dir): BN =>
    dir === 'xy'
      ? b.L.times(new BigNumber(1).div(b.sPa).minus(new BigNumber(1).div(b.sP)))
      : b.L.times(b.sPb.minus(b.sP));

  return {
    edge,
    quote(dir, amt) {
      if (!pos(amt)) return ZERO_QUOTE;
      // Past the band edge the trade cannot complete — flag it without asking
      // the engine to throw (it would, with AmountOutGreaterThanBalance).
      if (amt.gte(edge(dir))) {
        return { ...ZERO_QUOTE, ideal: idealOut(dir, r, amt), exhausted: true };
      }
      try {
        return quoteFrom(swap(pool, dir, amt), dir, r, amt);
      } catch {
        return { ...ZERO_QUOTE, ideal: idealOut(dir, r, amt), exhausted: true };
      }
    },
  };
}

/** Max input (sold token) before the AutoRange band exhausts; 1 if undefined. */
export function arEdge(V: BN, r: BN, Pa: BN, Pb: BN, dir: Dir): BN {
  const book = makeReClammBook(V, r, Pa, Pb, new BigNumber(0));
  return book ? book.edge(dir) : new BigNumber(1);
}
