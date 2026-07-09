/**
 * Cost-vs-size SVG chart. Slippage/all-in values come from evalAt at full
 * BigNumber precision; only the pixel coordinates are narrowed to numbers.
 */
import { BigNumber, smart } from './numeric';
import { evalAt, type CostCtx } from './cost';
import type { Dir } from './pools';

export interface ChartOpts {
  ctx: CostCtx;
  dir: Dir;
  curAmt: number;
  xmax: number;
  edge: number;
  be: number | null;
  mode: 'slip' | 'all';
  pairX: string;
  pairY: string;
}

// Geometry returned alongside the SVG so the hover handler can map a trade
// size to pixel coordinates without re-deriving the y-scale.
export interface ChartGeom {
  W: number; H: number; padL: number; padR: number; padT: number;
  plotW: number; plotH: number; xmax: number; ymax: number; all: boolean;
}

export interface ChartResult { svg: string; geom: ChartGeom | null; }

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function drawChart(o: ChartOpts): ChartResult {
  const W = 720, H = 280, padL = 52, padR = 16, padT = 14, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB, N = 90;
  if (!(o.xmax > 0)) return { svg: '', geom: null };

  const all = o.mode === 'all';
  const slipPct = (a: number) => {
    const m = evalAt(o.ctx, new BigNumber(a));
    const ar = all ? m.aPct : m.ar.slippage;
    const st = all ? m.sPct : m.s.slippage;
    return { ar: ar.toNumber(), st: st.toNumber(), exhausted: m.ar.exhausted };
  };

  let ymax = 1e-6;
  // In all-in mode, scale from the slippage-dominated right edge so the gas
  // blow-up near a→0 is clipped (flat top) rather than wrecking the scale.
  if (all) {
    const me = slipPct(o.xmax * 0.66);
    ymax = Math.max(me.st, isFinite(me.ar) ? me.ar : 0, 1e-4) * 1.4;
  }

  const arP: [number, number][] = [];
  const stP: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const a = (o.xmax * i) / N;
    const m = slipPct(a);
    let s1 = m.ar;
    let s2 = m.st;
    if (m.exhausted) s1 = all ? ymax : clamp(m.ar, 0, 1);
    s1 = clamp(s1, 0, all ? ymax : 1);
    s2 = clamp(s2, 0, all ? ymax : 1);
    arP.push([a, s1]);
    stP.push([a, s2]);
    if (!all) ymax = Math.max(ymax, s1, s2);
  }
  if (!all) ymax = Math.min(ymax * 1.12, 1);

  const sx = (a: number) => padL + (a / o.xmax) * plotW;
  const sy = (s: number) => padT + plotH - (s / ymax) * plotH;
  const path = (q: [number, number][]) =>
    q.map((d, i) => (i ? 'L' : 'M') + sx(d[0]).toFixed(1) + ' ' + sy(d[1]).toFixed(1)).join(' ');

  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const sv = (ymax * i) / 4, yy = sy(sv);
    svg += '<line class="gridln" x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '"/>';
    svg += '<text class="axlab" x="' + (padL - 8) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end">' +
      (sv * 100).toFixed(sv < 0.001 ? 4 : sv < 0.1 ? 2 : 1) + '%</text>';
  }
  for (let i = 0; i <= 4; i++) {
    const xv = (o.xmax * i) / 4;
    svg += '<text class="axlab" x="' + sx(xv).toFixed(1) + '" y="' + (H - 12) + '" text-anchor="middle">' + smart(xv) + '</text>';
  }
  if (o.edge > 0 && o.edge <= o.xmax)
    svg += '<line x1="' + sx(o.edge).toFixed(1) + '" y1="' + padT + '" x2="' + sx(o.edge).toFixed(1) + '" y2="' + (padT + plotH) +
      '" stroke="var(--warn)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>';
  if (o.be && o.be > 0 && o.be <= o.xmax)
    svg += '<line x1="' + sx(o.be).toFixed(1) + '" y1="' + padT + '" x2="' + sx(o.be).toFixed(1) + '" y2="' + (padT + plotH) +
      '" stroke="var(--gold)" stroke-width="1.2" stroke-dasharray="2 3" opacity="0.9"/>';
  svg += '<path d="' + path(stP) + '" fill="none" stroke="var(--slate)" stroke-width="2"/>';
  svg += '<path d="' + path(arP) + '" fill="none" stroke="var(--accent)" stroke-width="2.4"/>';
  if (o.curAmt > 0 && o.curAmt <= o.xmax) {
    const cx = sx(o.curAmt);
    const mm = slipPct(o.curAmt);
    svg += '<line x1="' + cx.toFixed(1) + '" y1="' + padT + '" x2="' + cx.toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="var(--line2)" stroke-width="1"/>';
    svg += '<circle cx="' + cx.toFixed(1) + '" cy="' + sy(Math.min(mm.st, ymax)).toFixed(1) + '" r="4" fill="var(--slate)"/>';
    svg += '<circle cx="' + cx.toFixed(1) + '" cy="' + sy(Math.min(mm.ar, ymax)).toFixed(1) + '" r="4.5" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"/>';
  }
  // Right-aligned so it never collides with the centered x tick labels.
  svg += '<text class="axlab" x="' + (W - padR) + '" y="' + (H - 1) + '" text-anchor="end" fill="var(--muted2)">trade size (' +
    (o.dir === 'xy' ? o.pairX : o.pairY) + ' in)</text>';
  // Transparent capture rect (so empty plot area still gets pointer events) + empty hover layer.
  svg += '<rect id="hit" x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent"/>';
  svg += '<g id="hov"></g>';
  return { svg, geom: { W, H, padL, padR, padT, plotW, plotH, xmax: o.xmax, ymax, all } };
}
