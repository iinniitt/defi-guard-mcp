# DeFi Guard MCP

<!-- mcp-name: io.github.iinniitt/defi-guard-mcp -->

[![npm](https://img.shields.io/npm/v/@iniit/defi-guard-mcp)](https://www.npmjs.com/package/@iniit/defi-guard-mcp)
[![smithery badge](https://smithery.ai/badge/@iinniitt/defi-guard-mcp)](https://smithery.ai/server/@iinniitt/defi-guard-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The **safety layer that checks a DeFi transaction or token before your agent (or you) signs** — on **Base L2**. Sits in front of execution MCPs (it pairs with them, it doesn't compete): honeypot detection, owner-power scans, approval-drain checks, position health, and executable prices — all from live on-chain state.

No API keys required — works out of the box against public Base RPCs (bring your own RPC for speed via `BASE_RPC_URL`). Read-only: it never holds keys, signs, or submits.

## Guard-before-signing tools

| Tool | What it answers |
|---|---|
| `token_safety_screen` | "Is this token safe to buy/approve *before* I sign?" — **honeypot detection** (can you actually sell it back?), real round-trip cost (fees + tax both ways), and whether **ownership is renounced** (a live owner can often change taxes / pause / mint). One risk verdict. |
| `scan_dangerous_capabilities` | "What can the owner do to me?" — scans the **deployed bytecode** for owner-only powers: `mint`, `pause`, `blacklist`, adjustable fees/taxes, max-tx limits, trading toggles, proxy `upgradeTo`. Flags the *capability*, no explorer key needed. |
| `approval_risk` | "Is this approval dangerous?" — reads the live allowance an owner granted a spender, flags **unlimited approvals** (the allowance-drain vector) and whether the spender is a contract or an EOA. Current exposure = what could be pulled right now. |

## Data tools

| Tool | What it answers |
|---|---|
| `aave_position_health` | "Is this Aave V3 position safe?" — live health factor, collateral/debt in USD, LTV, liquidation threshold, and a plain risk level (`healthy` / `elevated` / `critical` / `LIQUIDATABLE`). |
| `quote_swap` | "What would this swap *actually* return right now?" — exact-input quote via Uniswap V3 QuoterV2, best of all 4 fee tiers, with gas estimate. Executable price, not an oracle. |
| `token_risk_snapshot` | "Can I get out of this token?" — ERC-20 metadata + **real market depth** measured by round-trip quotes (WETH → token → WETH) at two sizes. High round-trip loss = thin or trapped liquidity, whatever the chart says. |

## Why round-trip depth instead of "liquidity" numbers

TVL and pool-size numbers are easy to fake and easy to misread. A round-trip quote against live state measures the only thing that matters: **what you lose entering and exiting right now** (fees + price impact, both ways). If a token can be bought but not sold, this tool says so (`UNTRADABLE`).

## Install

```bash
npx @iniit/defi-guard-mcp        # or from source: npm install && npm run build
```

### Claude Code

```bash
claude mcp add defi-guard -- npx -y @iniit/defi-guard-mcp
```

### Any MCP client (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "defi-guard": {
      "command": "npx",
      "args": ["-y", "@iniit/defi-guard-mcp"],
      "env": { "BASE_RPC_URL": "https://your-rpc-if-you-have-one" }
    }
  }
}
```

`BASE_RPC_URL` is optional; without it the server rotates across public Base endpoints with automatic fallback and retries.

## Example

> "Before I approve TOKEN X to this router, is any of it risky?"

The agent calls `token_safety_screen` (can I sell it back? is ownership renounced?), `scan_dangerous_capabilities` (can the owner mint/blacklist/pause?), and `approval_risk` (is this an unlimited allowance to an EOA?) — and answers with live on-chain facts instead of vibes, before you sign.

## Honesty notes (read this)

- Quotes are **simulations against live state** (`eth_call`). Real execution adds slippage between quote and inclusion.
- Contract addresses (Aave V3 Pool, QuoterV2) are Base mainnet constants, validated against live chain state.
- This is a **read-only** tool. It never holds keys, signs, or submits transactions.
- Not financial advice; it reports on-chain state, decisions are yours.

## Test

```bash
npm run build   # tsc — type-checks and emits dist/. Tools are verified against live Base state.
```

## License

MIT
