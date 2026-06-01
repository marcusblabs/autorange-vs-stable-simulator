# AutoRange vs Stable Simulator

Compare swap slippage between a concentrated **AutoRange** band and a Curve-style **Stable** pool, on the same token pair and the same total capital.

Built for the case the [AutoRange Depth Simulator](https://marcusblabs.github.io/autorange-depth-simulator/) doesn't cover well: **correlated assets** where a stable-pool curve is the natural comparison, not a full-range constant product. The math is genuinely different — Curve's StableSwap invariant `D` solved by Newton iteration, not a CL band on virtual reserves — so this lives in its own page.

## Features

- **Import from Curve _or_ Balancer**: a source toggle. Curve scans the public registries (`main`, `factory-stable-ng`, `factory-tricrypto`, `crvusd`, …); Balancer uses the v3 GraphQL API (`poolGetPool`). Either way it autofills amplification `A`, swap fee, the current rate, coin symbols, and — for Balancer — the per-token rate-provider addresses.
- **Live rate-provider reads**: set the rate from on-chain `getRate()` (Balancer rate-provider standard) via a public RPC. Rate (Y per X) = `getRate(X) / getRate(Y)`. Handles wstETH/ETH, sDAI/DAI and any rated pair. Rate source toggle: **Market** (DefiLlama prices) / **Manual** / **Provider** (live contract read).
- **Per-book swap fees**: independent Stable fee and AutoRange fee, since a Balancer v3 AR pool can run a different fee than the Curve/Balancer stable pool it's compared against.
- **Gas-aware "all-in" cost**: all-in = slippage + swap fee + gas, where gas USD = `units × gwei × 1e-9 × ETH price`. Live gas price (public RPC) and ETH price (DefiLlama) auto-fetch on load; gas units per book are editable (Balancer v3 / AutoRange swaps cost more gas than Curve, so they default higher).
- **Break-even trade size**: the trade size where both books' all-in cost is equal. Below it, the lower-gas venue wins; above it, the lower-slippage venue wins. Marked on the chart (gold line) and shown as a stat.
- **Fit band to Stable**: given a target trade size, solves for the AutoRange band half-width whose all-in cost matches the Stable pool at that size — so you can size an AR position to behave like a given stable pool.
- **Cost-vs-size chart** with a toggle between **Slippage %** and **All-in %** (the latter shows the gas-driven crossover), AR band-edge and break-even markers.
- **Pool value in USD or token** with a one-click toggle (live DefiLlama prices).
- **Same design system** as the depth simulator (Defilytica colors, Satoshi typography, MUI cards) so they read as a suite.

## Math

Stable side (Curve StableSwap NG, n=2):
- Invariant `D` solves `4A(x+y) + D = 4AD + D³/(4xy)` by Newton iteration.
- `get_y` solves the quadratic `y² + (b−D)y = c` for the post-swap balance.
- Balances are rate-scaled (`xp_i = balance_i × rate_i`) so the same code handles plain stables and rated pools (e.g. wstETH).
- Output is fee-adjusted.

AutoRange side:
- Constant product on virtual reserves: `x_v = L/√P`, `y_v = L·√P`, with band exhaustion at `Pa`/`Pb`.
- Same fee applied for a fair comparison.

Both books are sized to the **same total value** at the **same rate**, so the only difference being measured is the curve shape.

## Default state

Opens prefilled with the **alUSD / frxUSD Stable NG pool** (`0x17f9682c9cd1a448b31c0428f1d0783ed13a9fa3`, A=300) so you can hit `Import` and see real numbers in two clicks. Token library is seeded with alUSD and frxUSD and their live DefiLlama prices.

## Run locally

```bash
python3 -m http.server
# open http://localhost:8000
```

Live import requires the page served over http(s) (DefiLlama and Curve APIs reject `file://` origins).

## Deploy

GitHub Pages from `main` branch root. Sibling tools:
- [autorange-depth-simulator](https://marcusblabs.github.io/autorange-depth-simulator/) — uncorrelated assets / depth multiplier
- [balancer-pool-explorer](https://marcusblabs.github.io/balancer-pool-explorer/)
- [balancer-portfolio-viewer](https://marcusblabs.github.io/balancer-portfolio-viewer/)
