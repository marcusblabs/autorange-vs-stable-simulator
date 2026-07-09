/**
 * Network/data layer: token prices (DefiLlama), Balancer v3 pool import, and
 * on-chain reads (rate providers + gas). Everything here is DOM-free and
 * returns plain data or throws — the UI owns status strings. Numeric outputs
 * are BigNumber so callers keep full precision.
 */
import { BigNumber, type BN } from './numeric';

export const BAL_API = 'https://api-v3.balancer.fi/';
// CORS-enabled public RPC for eth_call (getRate) + eth_gasPrice.
export const RPC = 'https://ethereum-rpc.publicnode.com';
export const GETRATE_SELECTOR = '0x679aefce'; // getRate() — Balancer rate-provider standard
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export const CHAINS: [string, string][] = [
  ['ethereum', 'Ethereum'], ['arbitrum', 'Arbitrum'], ['base', 'Base'], ['optimism', 'Optimism'],
  ['polygon', 'Polygon'], ['bsc', 'BNB Chain'], ['avax', 'Avalanche'], ['xdai', 'Gnosis'],
  ['monad', 'Monad'], ['coingecko', 'CoinGecko ID'],
];
export function chainLabel(k: string): string {
  const f = CHAINS.find((c) => c[0] === k);
  return f ? f[1] : k;
}

// Balancer GraphQL chain enums and their DefiLlama prefixes.
const BAL_CHAINS = ['MAINNET', 'ARBITRUM', 'BASE', 'OPTIMISM', 'POLYGON', 'GNOSIS', 'AVALANCHE', 'SONIC'];
const BAL_LLAMA: Record<string, string> = {
  MAINNET: 'ethereum', ARBITRUM: 'arbitrum', BASE: 'base', OPTIMISM: 'optimism',
  POLYGON: 'polygon', GNOSIS: 'xdai', AVALANCHE: 'avax', SONIC: 'sonic',
};

// ---------------------------------------------------------------------------
// Token prices
// ---------------------------------------------------------------------------

export interface Coin {
  price: number;
  symbol?: string;
  decimals?: number;
  confidence?: number;
  timestamp?: number;
}

export async function fetchPrices(ids: string[]): Promise<Record<string, Coin>> {
  const url = 'https://coins.llama.fi/prices/current/' + ids.join(',') + '?searchWidth=6h';
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return j.coins || {};
}

/** Case-insensitive lookup of a coin id in a DefiLlama response. */
export function pick(coins: Record<string, Coin>, id: string): Coin | null {
  if (coins[id]) return coins[id];
  const k = Object.keys(coins).find((k) => k.toLowerCase() === id.toLowerCase());
  return k ? coins[k] : null;
}

async function fetchTokenUsd(chainEnum: string, address: string): Promise<BN> {
  const key = BAL_LLAMA[chainEnum];
  if (!key || !address) return new BigNumber(0);
  try {
    const id = key + ':' + address.toLowerCase();
    const r = await fetch('https://coins.llama.fi/prices/current/' + id);
    const j = await r.json();
    const c = j && j.coins && j.coins[id];
    return c && c.price > 0 ? new BigNumber(c.price) : new BigNumber(0);
  } catch {
    return new BigNumber(0);
  }
}

/** First 0x…40-hex match anywhere in a string (handles full pool URLs). */
export function parseAddr(s: string): string {
  const m = (s || '').trim().match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0].toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Balancer v3 pool import (Stable pools only)
// ---------------------------------------------------------------------------

export interface BalancerImport {
  name: string;
  chain: string; // Balancer GraphQL enum, e.g. MAINNET
  type: string;
  A: BN;
  feePct: BN; // percent, e.g. 0.04
  rate: BN; // Y per X
  rpx: string; // rate provider for X ('' = none)
  rpy: string; // rate provider for Y ('' = none)
  coins: string[];
  priceY: BN; // USD price of the quote token (0 if unknown)
}

/** Thrown when an address resolves to a non-stable Balancer pool. */
export class WrongPoolTypeError extends Error {}

/**
 * Look up a Balancer v3 pool by address (v3 pools use the address as their id),
 * scanning supported chains. Returns its stable params, or throws.
 */
export async function importBalancer(
  raw: string,
  onStatus?: (msg: string) => void,
): Promise<BalancerImport> {
  const addr = parseAddr(raw);
  if (!addr) throw new Error('Paste a Balancer pool address (or balancer.fi URL).');

  let pool: any = null;
  let chain: string | null = null;
  for (const ch of BAL_CHAINS) {
    onStatus?.('Checking Balancer on ' + ch + '…');
    const q =
      `{ poolGetPool(id:"${addr}", chain:${ch}) { name type dynamicData { swapFee } ` +
      `... on GqlPoolStable { amp poolTokens { symbol address priceRate priceRateProvider } } } }`;
    try {
      const r = await fetch(BAL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const j = await r.json();
      const p = j && j.data && j.data.poolGetPool;
      if (p) {
        pool = p;
        chain = ch;
        break;
      }
    } catch {
      /* chain miss → keep scanning */
    }
  }
  if (!pool || !chain) {
    throw new Error('Not found as a Balancer v3 pool on any supported chain. (v2 pools use a 66-char id.)');
  }
  if (pool.type !== 'STABLE') {
    throw new WrongPoolTypeError(
      'Found a ' + pool.type + ' Balancer pool — this simulator compares against StableSwap pools only.',
    );
  }

  const A = new BigNumber(pool.amp || 300);
  const feePct = new BigNumber((pool.dynamicData && pool.dynamicData.swapFee) || 0.0004).times(100);
  const toks = pool.poolTokens || [];
  const coins: string[] = toks.map((t: any) => t.symbol || '?');

  let rate = new BigNumber(1);
  let rpx = '';
  let rpy = '';
  if (toks.length >= 2) {
    const rX = new BigNumber(toks[0].priceRate || 1);
    const rY = new BigNumber(toks[1].priceRate || 1);
    if (rX.gt(0) && rY.gt(0)) rate = rX.div(rY);
    const px = toks[0].priceRateProvider || '';
    const py = toks[1].priceRateProvider || '';
    rpx = px.toLowerCase() === ZERO_ADDR ? '' : px;
    rpy = py.toLowerCase() === ZERO_ADDR ? '' : py;
  }

  onStatus?.('Fetching ' + (coins[1] || 'quote') + ' price…');
  const priceY = toks[1] ? await fetchTokenUsd(chain, toks[1].address) : new BigNumber(0);

  return { name: pool.name || addr.slice(0, 10), chain, type: pool.type, A, feePct, rate, rpx, rpy, coins, priceY };
}

// ---------------------------------------------------------------------------
// Curve pool import (StableSwap registries; Ethereum mainnet)
// ---------------------------------------------------------------------------

const CURVE_API = 'https://api.curve.finance/v1/getPools/ethereum/';
// Registries whose pools use the StableSwap invariant → importable.
const CURVE_STABLE_REGS = ['factory-stable-ng', 'main', 'factory', 'crvusd'];
// CryptoSwap registries → found-but-wrong-type (different invariant).
const CURVE_CRYPTO_REGS = ['factory-crypto', 'factory-twocrypto', 'factory-tricrypto', 'crypto'];
const CURVE_FEE_SELECTOR = '0xddca3f43'; // fee() — 1e10-scaled fraction

async function findInCurveRegistries(addr: string, regs: string[], onStatus?: (m: string) => void): Promise<any | null> {
  for (const reg of regs) {
    onStatus?.('Checking Curve ' + reg + '…');
    try {
      const r = await fetch(CURVE_API + reg);
      if (!r.ok) continue;
      const j = await r.json();
      const pools = (j && j.data && j.data.poolData) || [];
      const hit = pools.find((p: any) => (p.address || '').toLowerCase() === addr);
      if (hit) return hit;
    } catch {
      /* registry miss → keep scanning */
    }
  }
  return null;
}

/** Curve pool swap fee in percent, read on-chain (fee() is 1e10-scaled). */
async function curveFeePct(addr: string): Promise<BN> {
  try {
    const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data: CURVE_FEE_SELECTOR }, 'latest'] };
    const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error || !j.result || j.result === '0x') throw new Error('no fee()');
    return new BigNumber(BigInt(j.result).toString()).div('1e10').times(100);
  } catch {
    return new BigNumber(0.04); // Curve stable default
  }
}

/**
 * Look up a Curve pool by address across the StableSwap registries.
 * Returns the same shape as importBalancer so the UI treats both alike.
 */
export async function importCurve(
  raw: string,
  onStatus?: (msg: string) => void,
): Promise<BalancerImport> {
  const addr = parseAddr(raw);
  if (!addr) throw new Error('Paste a Curve pool address (or curve.finance URL).');

  const hit = await findInCurveRegistries(addr, CURVE_STABLE_REGS, onStatus);
  if (!hit) {
    // Distinguish "crypto pool" from "not found" for a useful error.
    const crypto = await findInCurveRegistries(addr, CURVE_CRYPTO_REGS, onStatus);
    if (crypto) {
      throw new WrongPoolTypeError(
        'Found ' + (crypto.name || addr.slice(0, 10)) + ' in a Curve CryptoSwap registry — ' +
        'this simulator compares against StableSwap pools only.',
      );
    }
    throw new Error('Not found in any Curve mainnet StableSwap registry.');
  }

  const A = new BigNumber(hit.amplificationCoefficient || 300);
  onStatus?.('Reading fee() on-chain…');
  const feePct = await curveFeePct(addr);

  const coinsArr: any[] = hit.coins || [];
  const coins: string[] = coinsArr.map((c) => c.symbol || '?');
  // Rate (Y per X) and quote price from the registry's per-coin USD prices.
  let rate = new BigNumber(1);
  let priceY = new BigNumber(0);
  if (coinsArr.length >= 2) {
    const p0 = new BigNumber(coinsArr[0].usdPrice || 0);
    const p1 = new BigNumber(coinsArr[1].usdPrice || 0);
    if (p0.gt(0) && p1.gt(0)) rate = p0.div(p1);
    if (p1.gt(0)) priceY = p1;
  }

  const oracleNote = hit.usesRateOracle ? ' (uses rate oracle)' : '';
  return {
    name: 'Curve · ' + (hit.name || hit.symbol || addr.slice(0, 10)) + oracleNote,
    chain: 'MAINNET',
    type: 'STABLE',
    A,
    feePct,
    rate,
    rpx: '', // Curve pools rate-scale internally; no Balancer-style getRate providers
    rpy: '',
    coins,
    priceY,
  };
}

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

/** Read getRate() from a rate-provider contract → its 1e18-scaled rate. */
export async function rpcGetRate(to: string): Promise<BN> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: GETRATE_SELECTOR }, 'latest'] };
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  const h = j.result;
  if (!h || h === '0x') throw new Error('empty result (not a getRate provider?)');
  return new BigNumber(BigInt(h).toString()).div('1e18');
}

export interface RateRead {
  rate: BN;
  rX: BN | null; // null = no provider on that side (rate 1)
  rY: BN | null;
}

/** rate = getRate(X) / getRate(Y); a blank side means that token's rate is 1. */
export async function readRateProviders(axRaw: string, ayRaw: string): Promise<RateRead> {
  const ax = parseAddr(axRaw);
  const ay = parseAddr(ayRaw);
  if (!ax && !ay) throw new Error('Enter at least one rate provider address.');
  const rX = ax ? await rpcGetRate(ax) : null;
  const rY = ay ? await rpcGetRate(ay) : null;
  const rate = (rX ?? new BigNumber(1)).div(rY ?? new BigNumber(1));
  return { rate, rX, rY };
}

export interface GasRead {
  gwei: BN;
  ethUsd: BN;
}

/** Live gas price (gwei) and ETH USD price. */
export async function refreshGas(): Promise<GasRead> {
  const [gr, pr] = await Promise.all([
    fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    }).then((r) => r.json()),
    fetch('https://coins.llama.fi/prices/current/coingecko:ethereum').then((r) => r.json()),
  ]);
  const gwei = gr && gr.result ? new BigNumber(BigInt(gr.result).toString()).div('1e9') : new BigNumber(0);
  const ep = pr && pr.coins && pr.coins['coingecko:ethereum'] && pr.coins['coingecko:ethereum'].price;
  const ethUsd = ep > 0 ? new BigNumber(ep) : new BigNumber(0);
  return { gwei, ethUsd };
}
