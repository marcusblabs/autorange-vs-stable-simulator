# AutoRange vs Stable Simulator

Compare swap slippage between a concentrated **AutoRange** band and a Balancer **Stable** pool, on the same token pair and the same total capital.

Built for the case the [AutoRange Depth Simulator](https://marcusblabs.github.io/autorange-depth-simulator/) doesn't cover well: **correlated assets** where a stable-pool curve is the natural comparison, not a full-range constant product. The two curves are genuinely different — a StableSwap invariant vs a concentrated-liquidity band on virtual reserves — so this lives in its own page.

Both books are evaluated with the official **[`@balancer-labs/balancer-maths`](https://github.com/balancer/balancer-maths)** library, so the numbers match Balancer v3 on-chain behaviour (fee-on-input, exact 18-decimal fixed point) rather than a re-derived approximation:

- **Stable** side → the `Stable` pool type (Balancer StableSwap).
- **AutoRange** side → the `ReClamm` pool type (Balancer's readjusting concentrated-liquidity AMM).

## Stack

- **TypeScript + [Vite](https://vitejs.dev/)** — no framework, a thin DOM layer over a pure-function core.
- **[`@balancer-labs/balancer-maths`](https://www.npmjs.com/package/@balancer-labs/balancer-maths)** — all pool math; no formulas are hand-coded.
- **[`bignumber.js`](https://mikemcl.github.io/bignumber.js/)** — every calculation runs at full precision; values are only narrowed to a few decimals at display time.

## Features

- **Import from Balancer**: paste a Balancer v3 pool address (or a `balancer.fi` URL) and it autofills amplification `A`, swap fee, the current rate, coin symbols, and the per-token rate-provider addresses. Uses the v3 GraphQL API (`poolGetPool`) and scans the supported chains automatically.
- **Live rate-provider reads**: set the rate from on-chain `getRate()` (the Balancer rate-provider standard) via a public RPC. Rate (Y per X) = `getRate(X) / getRate(Y)`. Handles wstETH/ETH, sDAI/DAI and any rated pair. Rate source toggle: **Market** (DefiLlama prices) / **Manual** / **Provider** (live contract read).
- **Per-book swap fees**: independent Stable fee and AutoRange fee, since an AutoRange pool can run a different fee than the stable pool it's compared against.
- **Gas-aware "all-in" cost**: all-in = slippage + swap fee + gas, where gas USD = `units × gwei × 1e-9 × ETH price`. Live gas price (public RPC) and ETH price (DefiLlama) auto-fetch on load; gas units per book are editable (AutoRange / reCLAMM swaps cost more gas than a plain stable swap, so they default higher).
- **Break-even trade size**: the trade size where both books' all-in cost is equal. Below it, the lower-gas venue wins; above it, the lower-slippage venue wins. Marked on the chart (gold line) and shown as a stat.
- **Fit band to Stable**: given a target trade size, solves for the AutoRange band half-width whose all-in cost matches the Stable pool at that size — so you can size an AR position to behave like a given stable pool.
- **Cost-vs-size chart** with a toggle between **Slippage %** and **All-in %** (the latter shows the gas-driven crossover), AR band-edge and break-even markers.
- **Pool value in USD or token** with a one-click toggle (live DefiLlama prices).
- **Same design system** as the depth simulator (Defilytica colors, Satoshi typography, MUI cards) so they read as a suite.

## Math

Both pools are synthesized from high-level inputs (total value `V` in Y units, rate `r`, amplification `A`, fee, band `[Pa, Pb]`) and handed to `balancer-maths` as Balancer v3 pool state.

**Stable side** — a balanced `Stable` pool where each side holds equal value (live balances `V/2` each). The rate enters as token X's rate provider, so correlated pairs (wstETH/ETH …) trade as if balanced. `balancer-maths` solves the StableSwap invariant and applies the swap fee on the input.

**AutoRange side** — a `ReClamm` pool whose real + virtual balances are built from the band so the constant-product invariant `(Rᵢ + Vᵢ)` reproduces exactly `[Pa, Pb]`:

```
L  = V / (2√P − P/√Pb − √Pa)      (concentrated-liquidity depth, P clamped into the band)
Va = L/√Pb,   Vb = L·√Pa           (reCLAMM virtual balances)
Ra = L(1/√P − 1/√Pb),  Rb = L(√P − √Pa)   (real balances)
```

With these, `balancer-maths` reports `minPrice = Pa`, `maxPrice = Pb`, spot `= P`. The reCLAMM time-based recentering / price-shift machinery is disabled (`lastTimestamp == currentTimestamp`), so the band you set is the band that's quoted. Past the band edge the trade can't complete — flagged as "exhausted".

Both books are sized to the **same total value** at the **same rate**, so the only difference being measured is the curve shape.

## Default state

Opens prefilled with two example stablecoins (alUSD / frxUSD) and their live DefiLlama prices, so **Use pair** derives a live rate immediately. The import box is prefilled with an example Balancer v3 stable pool (`0x111ce2a60c30f6058a57d0dbae1a39a42d998826`, msUSD/USDC) so you can hit **Import** and see real on-chain parameters in two clicks.

## Run locally

```bash
npm install
npm run dev
# open http://localhost:5173
```

Live import and pricing require the page served over http(s) (DefiLlama, Balancer and RPC APIs reject `file://` origins) — the dev server handles that.

## Build & deploy

```bash
npm run build      # typechecks, then bundles to dist/
npm run preview    # serve the production build locally
```

`npm run build` emits a static site in `dist/` (relative asset paths, so it works at a domain root or under a GitHub Pages project path). Deploy `dist/` to GitHub Pages or any static host.

Sibling tools:
- [autorange-depth-simulator](https://marcusblabs.github.io/autorange-depth-simulator/) — uncorrelated assets / depth multiplier
- [balancer-pool-explorer](https://marcusblabs.github.io/balancer-pool-explorer/)
- [balancer-portfolio-viewer](https://marcusblabs.github.io/balancer-portfolio-viewer/)
