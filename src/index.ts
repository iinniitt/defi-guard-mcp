#!/usr/bin/env node
/**
 * DeFi Guard MCP — real-time DeFi risk tools on Base L2.
 *
 * Tools:
 *  - aave_position_health : Aave V3 position health (health factor, collateral, debt, LTV)
 *  - quote_swap           : exact-input swap quote via Uniswap V3 QuoterV2 (best fee tier)
 *  - token_risk_snapshot  : ERC-20 metadata + real liquidity depth via round-trip quotes
 *
 * All reads are on-chain via a Base RPC (BASE_RPC_URL env, defaults to the public endpoint).
 * Addresses were validated against live Base state in a prior audited engine.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, fallback, formatUnits, parseUnits, isAddress, type Address } from "viem";
import { base } from "viem/chains";

// User-supplied RPC first (paid endpoints are faster and unthrottled);
// otherwise rotate across public endpoints, which rate-limit bursts.
const PUBLIC_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];
const RPC_URL = process.env.BASE_RPC_URL;
const rpcTransport = RPC_URL
  ? http(RPC_URL)
  : fallback(PUBLIC_RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 500 })));

const AAVE_V3_POOL: Address = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const UNIV3_QUOTER: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const WETH: Address = "0x4200000000000000000000000000000000000006";

const FEE_TIERS = [100, 500, 3000, 10000] as const;

const client = createPublicClient({ chain: base, transport: rpcTransport });

const aavePoolAbi = [
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

// QuoterV2's quote functions are nonpayable but side-effect-free; declaring them
// `view` lets us use eth_call through readContract.
const quoterAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const erc20Abi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

interface Quote {
  amountOut: bigint;
  feeTier: number;
  gasEstimate: bigint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry transient RPC failures (public endpoints rate-limit bursts). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const delay of [0, 800, 2500]) {
    if (delay) await sleep(delay);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      // Pool-doesn't-exist reverts are permanent; don't retry those.
      if (msg.includes("revert") || msg.includes("returned no data")) throw err;
    }
  }
  throw lastErr;
}

/** Best exact-input quote across fee tiers; null if no pool has liquidity.
 *  Sequential on purpose: public RPCs throttle concurrent bursts. */
async function bestQuote(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
  let best: Quote | null = null;
  for (const fee of FEE_TIERS) {
    try {
      const [amountOut, , , gasEstimate] = await withRetry(() =>
        client.readContract({
          address: UNIV3_QUOTER,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        })
      );
      if (amountOut > 0n && (best === null || amountOut > best.amountOut)) {
        best = { amountOut, feeTier: fee, gasEstimate };
      }
    } catch {
      // no pool at this tier (or persistently unreachable) — skip
    }
  }
  return best;
}

function assertAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address: ${value}`);
  return value as Address;
}

const VERSION = "0.1.2";
const server = new McpServer({ name: "defi-guard-mcp", version: VERSION });

server.tool(
  "aave_position_health",
  "Check the live health of an Aave V3 position on Base: health factor, total collateral/debt (USD), LTV and liquidation threshold. A health factor below 1.0 means the position is liquidatable.",
  { address: z.string().describe("EVM address of the position owner") },
  async ({ address }) => {
    const user = assertAddress(address, "address");
    const [collateral, debt, availableBorrows, liqThreshold, ltv, healthFactor] = await client.readContract({
      address: AAVE_V3_POOL,
      abi: aavePoolAbi,
      functionName: "getUserAccountData",
      args: [user],
    });
    const hasPosition = collateral > 0n || debt > 0n;
    const hf = debt === 0n ? null : Number(formatUnits(healthFactor, 18));
    const result = {
      network: "base",
      address: user,
      hasPosition,
      totalCollateralUsd: Number(formatUnits(collateral, 8)),
      totalDebtUsd: Number(formatUnits(debt, 8)),
      availableBorrowsUsd: Number(formatUnits(availableBorrows, 8)),
      currentLiquidationThresholdPct: Number(liqThreshold) / 100,
      ltvPct: Number(ltv) / 100,
      healthFactor: hf,
      riskLevel:
        !hasPosition || debt === 0n
          ? "none"
          : hf! < 1.0
            ? "LIQUIDATABLE"
            : hf! < 1.1
              ? "critical"
              : hf! < 1.5
                ? "elevated"
                : "healthy",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "quote_swap",
  "Real exact-input swap quote on Base via Uniswap V3 QuoterV2. Tries all fee tiers (0.01%, 0.05%, 0.3%, 1%) and returns the best executable output. Amounts are human units (e.g. '0.5').",
  {
    tokenIn: z.string().describe("Input token address"),
    tokenOut: z.string().describe("Output token address"),
    amountIn: z.string().describe("Human-readable input amount, e.g. '0.5'"),
  },
  async ({ tokenIn, tokenOut, amountIn }) => {
    const tin = assertAddress(tokenIn, "tokenIn");
    const tout = assertAddress(tokenOut, "tokenOut");
    const decIn = await withRetry(() => client.readContract({ address: tin, abi: erc20Abi, functionName: "decimals" }));
    const decOut = await withRetry(() => client.readContract({ address: tout, abi: erc20Abi, functionName: "decimals" }));
    const amount = parseUnits(amountIn, decIn);
    const quote = await bestQuote(tin, tout, amount);
    if (!quote) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No Uniswap V3 pool with liquidity found for this pair on Base." }) }],
      };
    }
    const result = {
      network: "base",
      dex: "uniswap-v3",
      tokenIn: tin,
      tokenOut: tout,
      amountIn,
      amountOut: formatUnits(quote.amountOut, decOut),
      bestFeeTierPct: quote.feeTier / 10000,
      swapGasEstimate: quote.gasEstimate.toString(),
      note: "Simulated via QuoterV2 eth_call against live Base state; executable price, not an oracle price.",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "token_risk_snapshot",
  "Liquidity risk snapshot of an ERC-20 on Base: metadata plus REAL market depth measured by round-trip quotes (WETH -> token -> WETH) at two trade sizes. High round-trip loss = thin/illiquid or high-fee market; a token you cannot exit is a risk regardless of its chart.",
  { token: z.string().describe("ERC-20 token address on Base") },
  async ({ token }) => {
    const t = assertAddress(token, "token");
    const name = await withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "name" }));
    const symbol = await withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }));
    const decimals = await withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }));
    const totalSupply = await withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "totalSupply" }));

    async function roundTrip(wethIn: string) {
      const amountIn = parseUnits(wethIn, 18);
      const buy = await bestQuote(WETH, t, amountIn);
      if (!buy) return { wethIn, tradable: false as const };
      const sell = await bestQuote(t, WETH, buy.amountOut);
      if (!sell) return { wethIn, tradable: false as const, note: "buyable but no exit route" };
      const retention = Number(sell.amountOut) / Number(amountIn);
      return {
        wethIn,
        tradable: true as const,
        tokensReceived: formatUnits(buy.amountOut, decimals),
        wethBack: formatUnits(sell.amountOut, 18),
        roundTripLossPct: Number(((1 - retention) * 100).toFixed(3)),
        buyFeeTierPct: buy.feeTier / 10000,
        sellFeeTierPct: sell.feeTier / 10000,
      };
    }

    const [small, large] = [await roundTrip("0.1"), await roundTrip("1")];
    const worstLoss = Math.max(
      small.tradable ? small.roundTripLossPct : 100,
      large.tradable ? large.roundTripLossPct : 100
    );
    const result = {
      network: "base",
      token: t,
      name,
      symbol,
      decimals,
      totalSupply: formatUnits(totalSupply, decimals),
      depthProbe: { small, large },
      liquidityRisk: worstLoss >= 100 ? "UNTRADABLE" : worstLoss > 10 ? "high" : worstLoss > 3 ? "medium" : "low",
      note: "Depth measured with live round-trip quotes on Uniswap V3 (Base). Loss includes pool fees + price impact both ways.",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`defi-guard-mcp v${VERSION} ready (rpc: ${RPC_URL ?? "public fallback pool"})`);
