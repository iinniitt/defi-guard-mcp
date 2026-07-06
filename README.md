# DeFi Guard MCP

Real-time DeFi risk tools for AI agents, on **Base L2**. Give your agent eyes on live on-chain state before it (or you) touch DeFi: position health, executable swap prices, and honest token liquidity checks.

No API keys required — works out of the box against public Base RPCs (bring your own RPC for speed via `BASE_RPC_URL`).

## Tools

| Tool | What it answers |
|---|---|
| `aave_position_health` | "Is this Aave V3 position safe?" — live health factor, collateral/debt in USD, LTV, liquidation threshold, and a plain risk level (`healthy` / `elevated` / `critical` / `LIQUIDATABLE`). |
| `quote_swap` | "What would this swap *actually* return right now?" — exact-input quote via Uniswap V3 QuoterV2, best of all 4 fee tiers, with gas estimate. Executable price, not an oracle. |
| `token_risk_snapshot` | "Can I get out of this token?" — ERC-20 metadata + **real market depth** measured by round-trip quotes (WETH → token → WETH) at two sizes. High round-trip loss = thin or trapped liquidity, whatever the chart says. |

## Why round-trip depth instead of "liquidity" numbers

TVL and pool-size numbers are easy to fake and easy to misread. A round-trip quote against live state measures the only thing that matters: **what you lose entering and exiting right now** (fees + price impact, both ways). If a token can be bought but not sold, this tool says so (`UNTRADABLE`).

## Install

```bash
npm install && npm run build
```

### Claude Code

```bash
claude mcp add defi-guard -- node <path-to>/defi-guard-mcp/dist/index.js
```

### Any MCP client (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "defi-guard": {
      "command": "node",
      "args": ["<path-to>/defi-guard-mcp/dist/index.js"],
      "env": { "BASE_RPC_URL": "https://your-rpc-if-you-have-one" }
    }
  }
}
```

`BASE_RPC_URL` is optional; without it the server rotates across public Base endpoints with automatic fallback and retries.

## Example

> "Check the health of 0xABC... on Aave and tell me if TOKEN X is safe to hold 1 ETH of."

The agent calls `aave_position_health` + `token_risk_snapshot` and answers with live numbers instead of vibes.

## Honesty notes (read this)

- Quotes are **simulations against live state** (`eth_call`). Real execution adds slippage between quote and inclusion.
- Contract addresses (Aave V3 Pool, QuoterV2) are Base mainnet constants, validated against live chain state.
- This is a **read-only** tool. It never holds keys, signs, or submits transactions.
- Not financial advice; it reports on-chain state, decisions are yours.

## Test

```bash
npm run smoke   # spawns the server over stdio and exercises all 3 tools against live Base
```

## License

MIT
