/**
 * AutoRange vs Stable Simulator — app entry.
 *
 * Compares two Balancer v3 books (StableSwap vs AutoRange/reCLAMM) on the same
 * pair and capital. All pool math runs through @balancer-labs/balancer-maths
 * (see pools.ts); all arithmetic is bignumber.js, narrowed to a few decimals
 * only at display time. This module owns the DOM: state, the recompute loop,
 * the token registry, imports, and event wiring.
 */
import { BigNumber, type BN, smart, pct } from './numeric';
import {
  els, initEls, inp, valOf, num, setSig, setFixed, text, html, show, isActive,
  gt0, gte0, escapeHtml,
} from './dom';
import {
  makeStableBook, makeReClammBook, arEdge, type Dir,
} from './pools';
import {
  gasUsd, evalAt, findBreakEven, fitBand, type CostCtx,
} from './cost';
import { drawChart } from './chart';
import {
  CHAINS, chainLabel, fetchPrices, pick, importBalancer, WrongPoolTypeError,
  readRateProviders, refreshGas,
} from './data';

// ---------------------------------------------------------------------------
// Element registry
// ---------------------------------------------------------------------------

const ELEMENT_IDS = [
  'chain', 'addr', 'addrhint', 'addtok', 'chips', 'chainhint', 'base', 'quote', 'apply', 'derived',
  'autoband', 'bandw', 'refresh', 'status', 'srctag', 'netdot', 'netlabel',
  'regpanel', 'regtoggle', 'regchev', 'regsummary', 'addchain', 'openlib',
  'importAddr', 'importBtn', 'importStatus',
  'A', 'fee', 'rate', 'rsMarket', 'rsManual', 'rsProvider', 'rateProviderBox', 'rpX', 'rpY', 'rpRead', 'rpStatus',
  'pa', 'pb', 'arfee', 'fitSize', 'fitBtn', 'fitStatus',
  'gwei', 'ethUsd', 'gasS', 'gasA', 'gasRefresh', 'gasStatus',
  'v', 'vunit', 'vuUsd', 'vuTok', 'vusd', 'ts', 'tsl', 'punit', 'tunit', 'note', 'tnote',
  'verdictBig', 'verdictSub', 'stStAll', 'stArAll', 'stBreak', 'stGas', 'stRate', 'stEdge', 'thout', 'notional',
  's_out', 's_sl', 's_gas', 's_all', 'a_out', 'a_sl', 'a_gas', 'a_all', 'slfac', 'chart',
  'chartToggle', 'cmSlip', 'cmAll', 'dxy', 'dyx', 'narrow', 'widen',
];

// ---------------------------------------------------------------------------
// Storage (safe: falls back to memory if blocked)
// ---------------------------------------------------------------------------

const store = (() => {
  let mem: Record<string, unknown> = {};
  let okFlag = true;
  try {
    const t = '__t';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
  } catch {
    okFlag = false;
  }
  return {
    get<T>(k: string): T | undefined {
      try {
        return okFlag ? (JSON.parse(localStorage.getItem(k) || 'null') as T) : (mem[k] as T);
      } catch {
        return mem[k] as T;
      }
    },
    set(k: string, v: unknown): void {
      try {
        okFlag ? localStorage.setItem(k, JSON.stringify(v)) : (mem[k] = v);
      } catch {
        mem[k] = v;
      }
    },
  };
})();
const KEY = 'arvs.tokens.v1';
const REGKEY = 'arsim.reg.collapsed';

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

interface Token {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  price: number | null;
  decimals?: number;
  confidence?: number;
  ts?: number;
}

const state = {
  tokens: (store.get<Record<string, Token>>(KEY) || {}) as Record<string, Token>,
  baseId: '',
  quoteId: '',
  dir: 'xy' as Dir,
  rateSource: 'market' as 'market' | 'manual' | 'provider',
  chartMode: 'slip' as 'slip' | 'all',
  // Active pair symbols drive every label + the USD/gas notional. The token
  // registry is the single source of truth — these are set by applyPair() /
  // setActivePair() only.
  pairX: 'WBTC',
  pairY: 'WETH',
  // Live USD price of the quote token (Y); pool value is denominated in Y, so
  // USD value = V × quotePriceUsd.
  quotePriceUsd: null as BN | null,
  valueUnit: 'USD' as 'USD' | 'TOK',
};

const or = (b: BN, fallback: BigNumber.Value): BN => (b.isFinite() ? b : new BigNumber(fallback));

/** Pool value in quote-token (Y) units, whatever the input unit is. */
function currentV(): BN {
  const raw = num('v');
  if (!raw.isFinite() || raw.lte(0)) return raw;
  if (state.valueUnit === 'USD') return state.quotePriceUsd ? raw.div(state.quotePriceUsd) : raw;
  return raw;
}

// ---------------------------------------------------------------------------
// Small status helpers
// ---------------------------------------------------------------------------

function setNet(okFlag: boolean): void {
  els.netdot.classList.toggle('off', !okFlag);
  text('netlabel', okFlag ? 'live' : 'offline');
}
function regStatus(msg: string, err = false): void {
  text('status', msg || '');
  els.status.classList.toggle('err', !!err);
}
function setStatus(id: string, msg: string, kind: '' | 'ok' | 'warn' = ''): void {
  els[id].style.color = kind === 'ok' ? 'var(--pos)' : kind === 'warn' ? 'var(--warn)' : '';
  text(id, msg);
}
function setBad(id: string, on: boolean): void {
  els[id].classList.toggle('bad', on);
}

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

async function addToken(): Promise<void> {
  const chain = inp('chain').value;
  const raw = valOf('addr').trim();
  let id: string;
  if (chain === 'coingecko') {
    if (!raw) {
      regStatus('Enter a CoinGecko id, e.g. bitcoin', true);
      return;
    }
    id = 'coingecko:' + raw.toLowerCase();
  } else {
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      regStatus('Enter a valid 0x contract address (40 hex chars).', true);
      return;
    }
    id = chain + ':' + raw.toLowerCase();
  }
  regStatus('Fetching ' + id + ' ...');
  try {
    const coins = await fetchPrices([id]);
    const c = pick(coins, id);
    if (!c || c.price == null) {
      regStatus('No price returned for ' + id + '. Check chain and address.', true);
      return;
    }
    state.tokens[id] = {
      id, chain, address: raw, symbol: c.symbol || '?', price: c.price,
      decimals: c.decimals, confidence: c.confidence, ts: c.timestamp,
    };
    store.set(KEY, state.tokens);
    inp('addr').value = '';
    setNet(true);
    render();
    regStatus('Added ' + (c.symbol || id) + ' at $' + smart(c.price));
  } catch (e) {
    setNet(false);
    regStatus(
      'Could not reach pricing API (' + (e as Error).message + '). If you are viewing this inside a chat preview, external requests are blocked. It works once the page is deployed or served locally.',
      true,
    );
  }
}

async function refreshAll(): Promise<void> {
  const ids = Object.keys(state.tokens);
  if (!ids.length) {
    regStatus('No tokens saved yet.');
    return;
  }
  regStatus('Refreshing ' + ids.length + ' price' + (ids.length > 1 ? 's' : '') + ' ...');
  try {
    const coins = await fetchPrices(ids);
    ids.forEach((id) => {
      const c = pick(coins, id);
      if (c && c.price != null) {
        const t = state.tokens[id];
        t.price = c.price;
        t.symbol = c.symbol || t.symbol;
        t.confidence = c.confidence;
        t.ts = c.timestamp;
      }
    });
    store.set(KEY, state.tokens);
    setNet(true);
    render();
    regStatus('Prices updated ' + new Date().toLocaleTimeString());
  } catch (e) {
    setNet(false);
    regStatus(
      'Could not reach pricing API (' + (e as Error).message + '). Live pricing needs the page served over http(s); you can still enter the band manually below.',
      true,
    );
  }
}

function removeToken(id: string): void {
  delete state.tokens[id];
  if (state.baseId === id) state.baseId = '';
  if (state.quoteId === id) state.quoteId = '';
  store.set(KEY, state.tokens);
  render();
}

function confDot(t: Token): string {
  if (t.price == null) return '';
  const low = t.confidence != null && t.confidence < 0.9;
  const title = t.confidence != null ? 'price confidence ' + (t.confidence * 100).toFixed(0) + '%' : 'live price';
  return '<span class="cdot' + (low ? ' low' : '') + '" title="' + title + '"></span>';
}

function render(): void {
  const activeChain = inp('chain').value;
  const all = Object.values(state.tokens);
  const onChain = all.filter((t) => t.chain === activeChain);
  const others = all.length - onChain.length;

  html(
    'chips',
    onChain
      .map(
        (t) =>
          '<div class="chip">' + confDot(t) + '<span class="csym">' + t.symbol + '</span><span class="cprice">' +
          (t.price != null ? '$' + smart(t.price) : '&mdash;') + '</span><button class="crm" data-rm="' + t.id + '">&times;</button></div>',
      )
      .join('') ||
      '<span style="color:var(--muted);font-size:12.5px">No tokens on ' + chainLabel(activeChain) + ' yet. Paste an address above.</span>',
  );
  els.chips.querySelectorAll<HTMLElement>('[data-rm]').forEach((b) => {
    b.onclick = () => removeToken(b.dataset.rm!);
  });

  text(
    'chainhint',
    others > 0 ? '+ ' + others + ' token' + (others > 1 ? 's' : '') + ' saved on other chains — switch the Chain selector to use them.' : '',
  );
  text(
    'regsummary',
    all.length
      ? all.length + ' token' + (all.length > 1 ? 's' : '') + ' saved · ' + onChain.length + ' on ' + chainLabel(activeChain)
      : 'No tokens saved yet',
  );
  text('addchain', 'on ' + chainLabel(activeChain));

  const opts = '<option value="">&mdash;</option>' + onChain.map((t) => '<option value="' + t.id + '">' + t.symbol + '</option>').join('');
  els.base.innerHTML = opts;
  els.quote.innerHTML = opts;
  if (state.tokens[state.baseId] && state.tokens[state.baseId].chain === activeChain) inp('base').value = state.baseId;
  else state.baseId = '';
  if (state.tokens[state.quoteId] && state.tokens[state.quoteId].chain === activeChain) inp('quote').value = state.quoteId;
  else state.quoteId = '';
  updateDerived();
}

function updateDerived(): void {
  const X = state.tokens[state.baseId];
  const Y = state.tokens[state.quoteId];
  if (X && Y && X.price && Y.price) {
    const P = new BigNumber(X.price).div(Y.price);
    html(
      'derived',
      '1 <b>' + X.symbol + '</b> = <span class="ar mono">' + smart(P) + '</span> <b>' + Y.symbol +
        '</b><span class="sub2">($' + smart(X.price) + ' / $' + smart(Y.price) + ')</span>',
    );
    inp('apply').disabled = false;
  } else {
    html('derived', 'Select two priced tokens to derive the pair price.');
    inp('apply').disabled = true;
  }
}

/** Make symX/symY the active pair (drives labels + the USD/gas notional). */
function setActivePair(symX?: string, symY?: string, priceYUsd?: BN | null): void {
  if (symX) state.pairX = symX;
  if (symY) state.pairY = symY;
  if (priceYUsd && priceYUsd.gt(0)) state.quotePriceUsd = priceYUsd;
  html(
    'derived',
    'Active pair: <b>' + escapeHtml(state.pairX) + '</b> / <b>' + escapeHtml(state.pairY) + '</b>' +
      (state.quotePriceUsd
        ? ' <span class="sub2">' + escapeHtml(state.pairY) + ' &approx; $' + smart(state.quotePriceUsd) + '</span>'
        : ' <span class="sub2">($-stable assumed)</span>') +
      ' <span class="sub2">· from imported pool</span>',
  );
}

function applyPair(): void {
  const X = state.tokens[state.baseId];
  const Y = state.tokens[state.quoteId];
  if (!(X && Y && X.price && Y.price)) return;
  const P = new BigNumber(X.price).div(Y.price); // Y per X
  state.pairX = X.symbol;
  state.pairY = Y.symbol;
  state.quotePriceUsd = new BigNumber(Y.price);
  setRateSource('market'); // "Use pair" anchors the rate to the live market price
  setSig('rate', P);
  if (inp('autoband').checked) {
    const w = BigNumber.max('0.0001', or(num('bandw'), 0.5).div(100));
    const s = new BigNumber(1).plus(w);
    setSig('pa', P.div(s));
    setSig('pb', P.times(s));
  }
  recompute();
}

// ---------------------------------------------------------------------------
// Registry drawer
// ---------------------------------------------------------------------------

function setReg(collapsed: boolean): void {
  els.regpanel.classList.toggle('collapsed', collapsed);
  els.regchev.innerHTML = collapsed ? '▸' : '▾';
  els.regtoggle.setAttribute('aria-expanded', String(!collapsed));
  store.set(REGKEY, collapsed);
}

// ---------------------------------------------------------------------------
// recompute — the model
// ---------------------------------------------------------------------------

function recompute(): void {
  const tx = state.pairX || 'X';
  const ty = state.pairY || 'Y';
  let Pa = num('pa');
  let Pb = num('pb');
  const A = num('A');
  const feeS = num('fee');
  const feeA = num('arfee');
  const r = num('rate');
  const V = currentV();

  // Auto-center the band on the rate at ±width%, unless the field is focused.
  if (inp('autoband').checked && gt0(r)) {
    const w = BigNumber.max('0.0001', or(num('bandw'), 0.5).div(100));
    const newPa = r.times(new BigNumber(1).minus(w));
    const newPb = r.times(new BigNumber(1).plus(w));
    if (!isActive('pa')) {
      setSig('pa', newPa);
      Pa = newPa;
    }
    if (!isActive('pb')) {
      setSig('pb', newPb);
      Pb = newPb;
    }
  }
  text('punit', '(' + ty + ' per ' + tx + ')');
  text('vuTok', ty);

  // Validation
  let bad = false;
  let msg = '';
  ['pa', 'pb', 'A', 'fee', 'arfee', 'rate', 'v'].forEach((id) => setBad(id, false));
  if (!gt0(Pa)) { bad = true; setBad('pa', true); }
  if (!(Pb.isFinite() && Pb.gt(Pa))) { bad = true; setBad('pb', true); msg = 'Upper bound must be above lower bound.'; }
  if (!gt0(A)) { bad = true; setBad('A', true); msg = msg || 'A must be > 0.'; }
  if (!gte0(feeS)) { bad = true; setBad('fee', true); msg = msg || 'Fee must be ≥ 0.'; }
  if (!gte0(feeA)) { bad = true; setBad('arfee', true); msg = msg || 'Fee must be ≥ 0.'; }
  if (!gt0(r)) { bad = true; setBad('rate', true); msg = msg || 'Rate must be > 0.'; }
  if (!gt0(V)) { bad = true; setBad('v', true); }
  if (bad) {
    text('note', msg || 'Check the highlighted inputs.');
    show('note', true);
    return;
  }
  show('note', false);

  // Pool-value readout (USD <-> Y token)
  if (state.valueUnit === 'USD') {
    html(
      'vusd',
      V.gt(0) && state.quotePriceUsd
        ? '&approx; <b>' + smart(V) + ' ' + ty + '</b> at $' + smart(state.quotePriceUsd) + '/' + ty
        : V.gt(0)
        ? '<span style="color:var(--muted)">Assuming ' + ty + ' &approx; $1 (load a pair for the live price)</span>'
        : '',
    );
  } else {
    html(
      'vusd',
      V.gt(0) && state.quotePriceUsd
        ? '&approx; <b>$' + smart(V.times(state.quotePriceUsd)) + '</b> at $' + smart(state.quotePriceUsd) + '/' + ty
        : '',
    );
  }

  // Trade probe range = 1.5× AR band edge
  let amt = num('ts');
  if (!gte0(amt)) amt = new BigNumber(0);
  const edge = arEdge(V, r, Pa, Pb, state.dir);
  const xmax = BigNumber.max(edge.times('1.5'), gt0(edge) ? edge : new BigNumber(1));
  inp('tsl').max = xmax.toString();
  inp('tsl').step = xmax.div(1000).toString();
  if (amt.gt(xmax)) amt = xmax;
  if (!isActive('ts')) setSig('ts', amt);
  inp('tsl').value = BigNumber.min(amt, xmax).toString();

  const soldTok = state.dir === 'xy' ? tx : ty;
  const gotTok = state.dir === 'xy' ? ty : tx;
  text('tunit', '(' + soldTok + ' in)');
  text('thout', 'Out (' + gotTok + ')');
  text('dxy', 'Sell ' + tx);
  text('dyx', 'Sell ' + ty);

  // Gas + price params
  const priceY = state.quotePriceUsd || new BigNumber(1);
  const gS = gasUsd(num('gasS'), num('gwei'), num('ethUsd'));
  const gA = gasUsd(num('gasA'), num('gwei'), num('ethUsd'));

  const stable = makeStableBook(V, r, A, feeS.div(100));
  const ar = makeReClammBook(V, r, Pa, Pb, feeA.div(100));
  if (!stable || !ar) {
    text('note', 'Could not build the pools from these inputs.');
    show('note', true);
    return;
  }
  const ctx: CostCtx = { stable, ar, dir: state.dir, r, priceY, gasS: gS, gasA: gA };

  // Current trade
  const m = evalAt(ctx, amt);
  const notionalUsd = m.notional;
  text('notional', amt.gt(0) ? 'notional ≈ $' + smart(notionalUsd) : '');

  // Outcome table
  text('s_out', smart(m.s.out));
  html('a_out', smart(m.ar.out) + (m.ar.exhausted ? ' <span style="color:var(--warn)">*</span>' : ''));
  text('s_sl', pct(m.s.slippage));
  text('a_sl', m.ar.exhausted ? '—' : pct(m.ar.slippage));
  text('s_gas', '$' + smart(gS));
  text('a_gas', '$' + smart(gA));
  html('s_all', amt.gt(0) ? '$' + smart(m.sAll) + ' <span class="muted">(' + pct(m.sPct) + ')</span>' : '$' + smart(gS));
  html(
    'a_all',
    m.ar.exhausted
      ? '<span style="color:var(--warn)">exhausted</span>'
      : amt.gt(0)
      ? '$' + smart(m.aAll) + ' <span class="muted">(' + pct(m.aPct) + ')</span>'
      : '$' + smart(gA),
  );

  // All-in verdict (gas-aware)
  let factor = '—';
  let verdictBig = '—';
  let verdictSub = 'Set a trade size to compare.';
  if (amt.gt(0)) {
    if (m.ar.exhausted) {
      verdictBig = '<span style="color:var(--warn)">AR band exhausted</span>';
      verdictSub = 'At this size the AutoRange band fills entirely and cannot complete the trade — Stable wins by default. Widen the band or trade smaller.';
      factor = '<span style="color:var(--warn)">AR exhausted</span>';
    } else {
      const aAll = m.aAll as BN;
      const arWins = aAll.lt(m.sAll);
      const cheap = arWins ? aAll : m.sAll;
      const dear = arWins ? m.sAll : aAll;
      const save = dear.minus(cheap);
      const ratioStr = cheap.gt(0) ? dear.div(cheap).toFixed(2) + '×' : '∞';
      if (save.div(BigNumber.max(notionalUsd, 1)).lt('1e-5')) {
        verdictBig = 'Roughly even';
        verdictSub = 'All-in costs are within a rounding error: Stable $' + smart(m.sAll) + ' vs AutoRange $' + smart(aAll) + '.';
        factor = '~even';
      } else {
        verdictBig = (arWins ? 'AutoRange' : 'Stable') + ' saves <b>$' + smart(save) + '</b>';
        verdictSub =
          'All-in ' + (arWins ? 'AutoRange' : 'Stable') + ' $' + smart(cheap) + ' vs ' + (arWins ? 'Stable' : 'AutoRange') +
          ' $' + smart(dear) + ' on this $' + smart(notionalUsd) + ' trade (' + ratioStr + ').';
        factor = (arWins ? 'AutoRange' : 'Stable') + ' cheaper by $' + smart(save);
      }
    }
  }
  html('verdictBig', verdictBig);
  html('verdictSub', verdictSub);
  html('slfac', factor);

  // Break-even trade size (all-in)
  const be = findBreakEven(ctx, edge);
  let beTxt = '—';
  if (be) {
    const small = evalAt(ctx, be.times('0.5'));
    const lowGasBook = small.aAll !== null && small.aAll.lt(small.sAll) ? 'AutoRange' : 'Stable';
    const hiGasBook = lowGasBook === 'AutoRange' ? 'Stable' : 'AutoRange';
    beTxt = smart(be) + ' ' + soldTok;
    els.stBreak.title = '≤ ' + smart(be) + ' ' + soldTok + ': ' + lowGasBook + ' cheaper (gas wins). Above: ' + hiGasBook + ' cheaper (slippage wins).';
  } else {
    els.stBreak.title = 'One book is cheaper across the whole range.';
  }

  // Stat tiles
  text('stStAll', amt.gt(0) ? '$' + smart(m.sAll) : '$' + smart(gS));
  text('stArAll', m.ar.exhausted ? '—' : amt.gt(0) ? '$' + smart(m.aAll) : '$' + smart(gA));
  text('stBreak', beTxt);
  text('stGas', '$' + smart(gS) + ' · $' + smart(gA));
  html('stRate', smart(r) + '<span class="unit">' + ty + '/' + tx + '</span>');
  html('stEdge', smart(edge) + '<span class="unit">' + (state.dir === 'xy' ? tx : ty) + '</span>');

  if (m.ar.exhausted) {
    html('tnote', '* AutoRange band exhausted at this trade size. In practice an AutoRange position recenters before the edge.');
    show('tnote', true);
  } else {
    show('tnote', false);
  }

  html(
    'chart',
    drawChart({
      ctx,
      dir: state.dir,
      curAmt: amt.toNumber(),
      xmax: xmax.toNumber(),
      edge: edge.toNumber(),
      be: be ? be.toNumber() : null,
      mode: state.chartMode,
      pairX: state.pairX,
      pairY: state.pairY,
    }),
  );
}

// ---------------------------------------------------------------------------
// Balancer pool import
// ---------------------------------------------------------------------------

async function importPool(): Promise<void> {
  const raw = valOf('importAddr');
  if (!raw.trim()) {
    setStatus('importStatus', 'Paste a Balancer stable pool address (or balancer.fi URL).', 'warn');
    return;
  }
  setStatus('importStatus', 'Looking up Balancer pool…');
  try {
    const res = await importBalancer(raw, (msg) => setStatus('importStatus', msg));
    setSig('A', res.A);
    setSig('fee', res.feePct);
    setSig('arfee', res.feePct); // default AR fee to the pool's fee
    setSig('rate', res.rate);
    inp('rpX').value = res.rpx;
    inp('rpY').value = res.rpy;
    setRateSource('manual'); // imported rate is a snapshot; switch to Provider for a live read
    setActivePair(res.coins[0], res.coins[1], res.priceY);
    const provNote = res.rpx || res.rpy
      ? ' · rate provider' + (res.rpx && res.rpy ? 's' : '') + ' loaded'
      : ' · no rate provider (constant rate)';
    setStatus(
      'importStatus',
      'Imported ' + res.name + ' (' + res.chain + ', ' + res.type + ') — A=' + smart(res.A) + ', fee=' +
        res.feePct.toFixed(3) + '%, rate=' + res.rate.precision(6).toString() + ', coins: ' + res.coins.join('/') + provNote,
      'ok',
    );
    recompute();
  } catch (e) {
    const m = (e as Error).message;
    setStatus('importStatus', e instanceof WrongPoolTypeError ? m : m, 'warn');
  }
}

// ---------------------------------------------------------------------------
// On-chain rate provider read
// ---------------------------------------------------------------------------

async function readRateProvider(): Promise<void> {
  setStatus('rpStatus', 'Reading getRate()…');
  try {
    const { rate, rX, rY } = await readRateProviders(valOf('rpX'), valOf('rpY'));
    setSig('rate', rate);
    setStatus(
      'rpStatus',
      'rate = ' + (rX ? rX.precision(6).toString() : '1') + ' / ' + (rY ? rY.precision(6).toString() : '1') + ' = ' + rate.precision(6).toString(),
      'ok',
    );
    recompute();
  } catch (e) {
    setStatus('rpStatus', 'Read failed: ' + (e as Error).message, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Live gas + ETH price
// ---------------------------------------------------------------------------

async function refreshGasUI(): Promise<void> {
  setStatus('gasStatus', 'Fetching live gas + ETH price…');
  try {
    const { gwei, ethUsd } = await refreshGas();
    if (gwei.gt(0)) setSig('gwei', gwei, 4);
    if (ethUsd.gt(0)) setFixed('ethUsd', ethUsd, 2);
    setStatus('gasStatus', 'Live: ' + valOf('gwei') + ' gwei · ETH $' + valOf('ethUsd'), 'ok');
    recompute();
  } catch (e) {
    setStatus('gasStatus', 'Gas fetch failed: ' + (e as Error).message + ' (enter values manually).', 'warn');
  }
}

// ---------------------------------------------------------------------------
// Fit AutoRange band to Stable
// ---------------------------------------------------------------------------

function fitBandUI(): void {
  const priceY = state.quotePriceUsd || new BigNumber(1);
  const res = fitBand({
    V: currentV(),
    r: num('rate'),
    A: num('A'),
    feeS: num('fee').div(100),
    feeA: num('arfee').div(100),
    dir: state.dir,
    priceY,
    gasS: gasUsd(num('gasS'), num('gwei'), num('ethUsd')),
    gasA: gasUsd(num('gasA'), num('gwei'), num('ethUsd')),
    target: num('fitSize'),
  });
  if (res.kind === 'infeasible') {
    setStatus('fitStatus', res.message, 'warn');
    return;
  }
  if (res.kind === 'ar-cheaper') {
    setStatus('fitStatus', res.message, 'ok');
    return;
  }
  // matched | stable-cheaper → apply the band
  if (res.Pa && res.Pb) {
    setSig('pa', res.Pa);
    setSig('pb', res.Pb);
  }
  inp('autoband').checked = false;
  if (res.kind === 'matched' && res.w) {
    setSig('bandw', res.w.times(100), 4);
    const tgt = num('fitSize');
    setStatus(
      'fitStatus',
      'Band ±' + res.w.times(100).toFixed(4) + '% matches Stable all-in ($' + smart(res.sAll) + ') at ' +
        smart(tgt) + ' ' + (state.dir === 'xy' ? state.pairX : state.pairY) + '.',
      'ok',
    );
  } else {
    setStatus('fitStatus', res.message, 'warn');
  }
  recompute();
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

function setRateSource(s: 'market' | 'manual' | 'provider'): void {
  state.rateSource = s;
  els.rsMarket.classList.toggle('on', s === 'market');
  els.rsManual.classList.toggle('on', s === 'manual');
  els.rsProvider.classList.toggle('on', s === 'provider');
  els.rateProviderBox.style.display = s === 'provider' ? 'block' : 'none';
  inp('rate').readOnly = s === 'market';
}

function setValueUnit(u: 'USD' | 'TOK'): void {
  if (u === state.valueUnit) return;
  const raw = num('v');
  if (raw.gt(0) && state.quotePriceUsd) {
    if (u === 'USD') setFixed('v', raw.times(state.quotePriceUsd), 2); // token -> USD
    else setSig('v', raw.div(state.quotePriceUsd)); // USD -> token
  }
  state.valueUnit = u;
  els.vuUsd.classList.toggle('on', u === 'USD');
  els.vuTok.classList.toggle('on', u !== 'USD');
  recompute();
}

function setChartMode(m: 'slip' | 'all'): void {
  state.chartMode = m;
  els.cmSlip.classList.toggle('on', m === 'slip');
  els.cmAll.classList.toggle('on', m === 'all');
  recompute();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire(): void {
  inp('chain').addEventListener('change', () => {
    const cg = inp('chain').value === 'coingecko';
    text('addrhint', cg ? '(coingecko id)' : '(0x...)');
    inp('addr').placeholder = cg ? 'bitcoin' : '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    // The chain is the active context for the pair — reset selection on switch.
    state.baseId = '';
    state.quoteId = '';
    render();
  });

  inp('addtok').onclick = addToken;
  inp('addr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addToken();
  });
  inp('refresh').onclick = refreshAll;
  inp('base').onchange = () => {
    state.baseId = inp('base').value;
    updateDerived();
  };
  inp('quote').onchange = () => {
    state.quoteId = inp('quote').value;
    updateDerived();
  };
  inp('apply').onclick = applyPair;

  els.regtoggle.addEventListener('click', () => setReg(!els.regpanel.classList.contains('collapsed')));
  els.regtoggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setReg(!els.regpanel.classList.contains('collapsed'));
    }
  });
  els.openlib.addEventListener('click', (e) => {
    e.preventDefault();
    setReg(false);
    els.regpanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    inp('addr').focus();
  });

  // Live-recompute inputs
  ['pa', 'pb', 'A', 'fee', 'arfee', 'rate', 'v', 'ts', 'bandw', 'gwei', 'ethUsd', 'gasS', 'gasA'].forEach((k) =>
    inp(k).addEventListener('input', recompute),
  );

  els.vuUsd.addEventListener('click', () => setValueUnit('USD'));
  els.vuTok.addEventListener('click', () => setValueUnit('TOK'));
  inp('tsl').addEventListener('input', () => {
    inp('ts').value = inp('tsl').value;
    recompute();
  });

  // Tighten/widen rescale the band around the current rate.
  inp('narrow').onclick = () => {
    const r = num('rate');
    const Pa = num('pa');
    const Pb = num('pb');
    if (!(gt0(r) && Pb.gt(Pa))) return;
    setSig('pa', r.minus(r.minus(Pa).times('0.6')));
    setSig('pb', r.plus(Pb.minus(r).times('0.6')));
    inp('autoband').checked = false;
    recompute();
  };
  inp('widen').onclick = () => {
    const r = num('rate');
    const Pa = num('pa');
    const Pb = num('pb');
    if (!(gt0(r) && Pb.gt(Pa))) return;
    setSig('pa', r.minus(r.minus(Pa).times('1.6')));
    setSig('pb', r.plus(Pb.minus(r).times('1.6')));
    inp('autoband').checked = false;
    recompute();
  };

  els.dxy.parentElement!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    state.dir = b.dataset.d as Dir;
    els.dxy.classList.toggle('on', state.dir === 'xy');
    els.dyx.classList.toggle('on', state.dir === 'yx');
    recompute();
  });
  inp('autoband').addEventListener('change', recompute);

  inp('importBtn').addEventListener('click', importPool);
  inp('importAddr').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      importPool();
    }
  });

  els.rsMarket.addEventListener('click', () => {
    setRateSource('market');
    if (state.tokens[state.baseId] && state.tokens[state.quoteId]) applyPair();
  });
  els.rsManual.addEventListener('click', () => setRateSource('manual'));
  els.rsProvider.addEventListener('click', () => setRateSource('provider'));
  inp('rpRead').addEventListener('click', readRateProvider);
  // Typing in the rate box implies manual control.
  inp('rate').addEventListener('input', () => {
    if (state.rateSource === 'market') setRateSource('manual');
  });

  inp('gasRefresh').addEventListener('click', refreshGasUI);
  inp('fitBtn').addEventListener('click', fitBandUI);
  els.cmSlip.addEventListener('click', () => setChartMode('slip'));
  els.cmAll.addEventListener('click', () => setChartMode('all'));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  initEls(ELEMENT_IDS);
  inp('chain').innerHTML = CHAINS.map((c) => '<option value="' + c[0] + '">' + c[1] + '</option>').join('');
  wire();

  const sc = store.get<boolean>(REGKEY);
  setReg(sc === undefined || sc === null ? true : !!sc);

  // Seed alUSD + frxUSD (the example pool's tokens) on first run.
  if (!Object.keys(state.tokens).length) {
    state.tokens = {
      'ethereum:0xbc6da0fe9ad5f3b0d58160288917aa56653660e9': {
        id: 'ethereum:0xbc6da0fe9ad5f3b0d58160288917aa56653660e9', chain: 'ethereum',
        address: '0xBC6DA0FE9aD5f3b0d58160288917AA56653660E9', symbol: 'alUSD', price: null,
      },
      'ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29': {
        id: 'ethereum:0xcacd6fd266af91b8aed52accc382b4e165586e29', chain: 'ethereum',
        address: '0xCAcd6fd266aF91b8AeD52aCCc382b4e165586E29', symbol: 'frxUSD', price: null,
      },
    };
    store.set(KEY, state.tokens);
  }
  const ids = Object.keys(state.tokens);
  if (ids.length && state.tokens[ids[0]]) inp('chain').value = state.tokens[ids[0]].chain;
  const sameChain = ids.filter((id) => state.tokens[id].chain === inp('chain').value);
  state.baseId = sameChain[0] || '';
  state.quoteId = sameChain[1] || '';

  // Pre-fill an example Balancer v3 stable pool (msUSD/USDC) so Import works
  // on the first try.
  if (!valOf('importAddr')) inp('importAddr').value = '0x111ce2a60c30f6058a57d0dbae1a39a42d998826';
  setRateSource('market');
  setChartMode('slip');
  render();
  recompute();

  // Fetch live token prices, gas, and ETH price in parallel.
  await Promise.all([refreshAll(), refreshGasUI()]);
  const X = state.tokens[state.baseId];
  const Y = state.tokens[state.quoteId];
  if (X && Y && X.price && Y.price) applyPair();
}

init();
