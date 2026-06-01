# AutoRange vs Stable Simulator

Compare swap slippage between a concentrated **AutoRange** band and a Curve-style **Stable** pool, on the same token pair and the same total capital.

Built for the case the [AutoRange Depth Simulator](https://marcusblabs.github.io/autorange-depth-simulator/) doesn't cover well: **correlated assets** where a stable-pool curve is the natural comparison, not a full-range constant product. The math is genuinely different — Curve's StableSwap invariant `D` solved by Newton iteration, not a CL band on virtual reserves — so this lives in its own page.

## Features

- **Import from Curve pool**: paste any Curve mainnet pool URL or address. The app scans Curve's registries (`main`, `factory-stable-ng`, `factory-tricrypto`, `crvusd`, …) and autofills the amplification `A`, swap fee, current rate, and coin symbols.
- **Manual mode**: set `A`, fee, rate (Y per X), AutoRange band `Pa`/`Pb`, and pool value yourself.
- **Oracle/rate ready**: the rate input is the single knob for non-1:1 correlated pairs (wstETH/ETH, sDAI/DAI, etc.). When a future contract-read hook is added, it plugs in here.
- **Pool value in USD or token** with a one-click toggle (powered by live DefiLlama prices for the saved tokens).
- **Side-by-side outcome**: Stable vs AutoRange — output, execution price, slippage. Verdict headline shows which is tighter and by how much, or flags `AR band exhausted` when the trade exceeds the band's capacity.
- **Slippage-vs-size chart** for both books, with the AR band-edge marked.
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
