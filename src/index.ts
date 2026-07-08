#!/usr/bin/env node
/**
 * DeFi Guard MCP — real-time DeFi safety + risk tools on Base L2.
 *
 * Data tools:
 *  - aave_position_health       : Aave V3 position health (health factor, collateral, debt, LTV)
 *  - quote_swap                 : exact-input swap quote via Uniswap V3 QuoterV2 (best fee tier)
 *  - token_risk_snapshot        : ERC-20 metadata + real liquidity depth via round-trip quotes
 *
 * Guard-before-signing tools (pre-trade safety, no explorer API key needed):
 *  - token_safety_screen        : honeypot (can you sell?) + round-trip cost + ownership renounced
 *  - scan_dangerous_capabilities: owner powers in bytecode (mint/pause/blacklist/fees/upgrade)
 *  - approval_risk              : live allowance + unlimited-approval / allowance-drain flagging
 *
 * All reads are on-chain via a Base RPC (BASE_RPC_URL env, defaults to the public endpoint).
 * Addresses were validated against live Base state in a prior audited engine.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, fallback, formatUnits, parseUnits, isAddress, toFunctionSelector, type Address } from "viem";
import { base } from "viem/chains";
import { meterUse } from "./metering.js";

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
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const UINT256_MAX = (1n << 256n) - 1n;

// Owner-only powers that let a token operator harm holders. We flag their PRESENCE in the deployed
// bytecode (a PUSH4 selector match) — it means the capability exists, not that it will be used.
const DANGEROUS_FUNCS: { sig: string; label: string; severity: "critical" | "high" | "medium" }[] = [
  { sig: "function mint(address,uint256)", label: "mint(address,uint256)", severity: "high" },
  { sig: "function mint(uint256)", label: "mint(uint256)", severity: "high" },
  { sig: "function pause()", label: "pause()", severity: "high" },
  { sig: "function blacklist(address)", label: "blacklist(address)", severity: "critical" },
  { sig: "function setBlacklist(address,bool)", label: "setBlacklist(address,bool)", severity: "critical" },
  { sig: "function addBlackList(address)", label: "addBlackList(address)", severity: "critical" },
  { sig: "function setFee(uint256)", label: "setFee(uint256)", severity: "medium" },
  { sig: "function setFees(uint256,uint256)", label: "setFees(uint256,uint256)", severity: "medium" },
  { sig: "function setTax(uint256)", label: "setTax(uint256)", severity: "medium" },
  { sig: "function setTaxes(uint256,uint256)", label: "setTaxes(uint256,uint256)", severity: "medium" },
  { sig: "function setMaxTxAmount(uint256)", label: "setMaxTxAmount(uint256)", severity: "medium" },
  { sig: "function setMaxWallet(uint256)", label: "setMaxWallet(uint256)", severity: "medium" },
  { sig: "function enableTrading()", label: "enableTrading()", severity: "medium" },
  { sig: "function setTradingEnabled(bool)", label: "setTradingEnabled(bool)", severity: "medium" },
  { sig: "function upgradeTo(address)", label: "upgradeTo(address) [proxy]", severity: "high" },
  { sig: "function upgradeToAndCall(address,bytes)", label: "upgradeToAndCall(address,bytes) [proxy]", severity: "high" },
];

const ownableAbi = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "getOwner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Best-effort owner read: try owner() then getOwner(). null = no standard owner fn (non-Ownable). */
async function readOwner(token: Address): Promise<string | null> {
  for (const fn of ["owner", "getOwner"] as const) {
    try {
      const o = await withRetry(() =>
        client.readContract({ address: token, abi: ownableAbi, functionName: fn })
      );
      return o as string;
    } catch {
      // function absent or reverts — try the next
    }
  }
  return null;
}

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

server.tool(
  "token_safety_screen",
  "Pre-trade safety screen for an ERC-20 on Base — the 'is this safe to buy/approve BEFORE I sign' check. Verifies you can actually SELL it back (honeypot detection), measures the real round-trip cost (buy+sell fees/tax), and reports whether ownership is renounced (a live owner can often change taxes, pause, or mint). Returns a single risk verdict. On-chain only; no oracle, no trust in the token's own claims.",
  { token: z.string().describe("ERC-20 token address on Base") },
  async ({ token }) => {
    const t = assertAddress(token, "token");
    const [symbol, decimals] = await Promise.all([
      withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "symbol" })).catch(() => "?"),
      withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })).catch(() => 18),
    ]);

    // Honeypot / sell-tax probe: buy with 0.05 WETH, then try to sell the received tokens back.
    const wethIn = parseUnits("0.05", 18);
    const buy = await bestQuote(WETH, t, wethIn);
    let sellable: boolean;
    let roundTripLossPct: number | null = null;
    let note: string;
    if (!buy) {
      sellable = false;
      note = "No Uniswap V3 pool with liquidity found — not tradable on the venues checked.";
    } else {
      const sell = await bestQuote(t, WETH, buy.amountOut);
      if (!sell) {
        sellable = false;
        note = "HONEYPOT SIGNAL: buyable but no executable sell route — you may not be able to exit.";
      } else {
        sellable = true;
        roundTripLossPct = Number(((1 - Number(sell.amountOut) / Number(wethIn)) * 100).toFixed(3));
        note = "Round-trip loss = buy+sell pool fees + price impact + any transfer tax, both directions.";
      }
    }

    const ownerRaw = await readOwner(t);
    const ownershipRenounced = ownerRaw === null ? null : ownerRaw.toLowerCase() === ZERO_ADDR;

    // Verdict: honeypot dominates; then live owner + high tax; then tax bands.
    let verdict: string;
    if (!buy) verdict = "UNTRADABLE";
    else if (!sellable) verdict = "HONEYPOT";
    else if (roundTripLossPct !== null && roundTripLossPct >= 50) verdict = "CRITICAL";
    else if (ownershipRenounced === false && roundTripLossPct !== null && roundTripLossPct > 15)
      verdict = "high";
    else if (roundTripLossPct !== null && roundTripLossPct > 15) verdict = "elevated";
    else if (roundTripLossPct !== null && roundTripLossPct > 5) verdict = "medium";
    else verdict = "low";

    const flags: string[] = [];
    if (verdict === "HONEYPOT") flags.push("cannot_sell");
    if (ownershipRenounced === false) flags.push("owner_not_renounced");
    if (ownershipRenounced === null) flags.push("no_standard_owner_fn");
    if (roundTripLossPct !== null && roundTripLossPct > 15) flags.push("high_round_trip_cost");

    const result = {
      network: "base",
      token: t,
      symbol,
      decimals,
      verdict,
      sellable,
      roundTripLossPct,
      ownershipRenounced, // true = renounced (safer), false = live owner, null = non-standard
      owner: ownerRaw,
      flags,
      note: `${note} Ownership: ${
        ownershipRenounced === null
          ? "no standard owner() — non-Ownable or custom access control (inspect further)"
          : ownershipRenounced
            ? "renounced (owner = 0x0)"
            : "LIVE owner — can potentially change taxes/pause/mint depending on the contract"
      }. This is a heuristic pre-trade screen, not a full audit.`,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "scan_dangerous_capabilities",
  "Scan a token/contract's DEPLOYED BYTECODE on Base for owner-only powers that can harm holders — mint, pause, blacklist, adjustable fees/taxes, max-tx limits, trading toggles, and proxy upgradeability. Flags the PRESENCE of each capability (a selector match in the code), i.e. what the operator COULD do, independent of the token's claims. No explorer API key needed. Heuristic: matches 4-byte selectors in runtime bytecode; a minimal proxy hides its real logic in the implementation (reported).",
  { token: z.string().describe("Contract/token address on Base") },
  async ({ token }) => {
    const gate = meterUse("scan_dangerous_capabilities");
    if (!gate.allowed) return { content: [{ type: "text", text: JSON.stringify({ error: "rate_limited", detail: gate.message }) }] };
    const t = assertAddress(token, "token");
    const code = await withRetry(() => client.getCode({ address: t }));
    if (!code || code === "0x") {
      return {
        content: [{ type: "text", text: JSON.stringify({ network: "base", address: t, isContract: false, note: "No bytecode at this address — it is an EOA (wallet), not a contract." }) }],
      };
    }
    const hay = code.toLowerCase();
    const found = DANGEROUS_FUNCS.filter((f) => hay.includes(toFunctionSelector(f.sig).slice(2).toLowerCase()))
      .map((f) => ({ capability: f.label, severity: f.severity }));
    const codeSizeBytes = (code.length - 2) / 2;
    const likelyProxy = codeSizeBytes < 200;
    const worst = found.some((f) => f.severity === "critical")
      ? "critical"
      : found.some((f) => f.severity === "high")
        ? "high"
        : found.some((f) => f.severity === "medium")
          ? "medium"
          : "low";
    const result = {
      network: "base",
      address: t,
      isContract: true,
      codeSizeBytes,
      likelyProxy,
      dangerousCapabilities: found,
      verdict: found.length === 0 ? "low" : worst,
      note:
        (likelyProxy
          ? "This looks like a minimal proxy — the real logic (and its powers) live in the implementation contract, which this scan does NOT see. Resolve the implementation and re-scan. "
          : "") +
        "Presence of a capability means the operator CAN do it, not that they will. Blacklist/mint on a live (non-renounced) owner is the highest concern — pair this with token_safety_screen for ownership status. Selector-match heuristic; verify critical hits against source.",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "approval_risk",
  "Assess the risk of an existing ERC-20 approval on Base BEFORE it can be abused: reads the live allowance an owner has granted a spender, flags UNLIMITED approvals (the allowance-drain vector — a compromised or malicious spender can pull up to the allowance), and reports whether the spender is a contract. Unlimited allowance to an EOA is a classic scam setup. Use before signing an approval, or to audit standing approvals.",
  {
    owner: z.string().describe("The wallet that granted the approval"),
    token: z.string().describe("The ERC-20 token address"),
    spender: z.string().describe("The address allowed to spend (router, contract, or EOA)"),
  },
  async ({ owner, token, spender }) => {
    const gate = meterUse("approval_risk");
    if (!gate.allowed) return { content: [{ type: "text", text: JSON.stringify({ error: "rate_limited", detail: gate.message }) }] };
    const o = assertAddress(owner, "owner");
    const t = assertAddress(token, "token");
    const s = assertAddress(spender, "spender");
    const allowance = await withRetry(() =>
      client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [o, s] })
    );
    const [decimals, balance, spenderCode] = await Promise.all([
      withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" })).catch(() => 18),
      withRetry(() => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [o] })).catch(() => 0n),
      withRetry(() => client.getCode({ address: s })).catch(() => undefined),
    ]);
    const unlimited = allowance >= UINT256_MAX / 2n;
    const spenderIsContract = !!spenderCode && spenderCode !== "0x";
    const exposure = allowance < balance ? allowance : balance; // what could actually be pulled now
    const verdict =
      allowance === 0n
        ? "none"
        : unlimited && !spenderIsContract
          ? "CRITICAL"
          : unlimited
            ? "high"
            : exposure > 0n
              ? "medium"
              : "low";
    const flags: string[] = [];
    if (unlimited) flags.push("unlimited_allowance");
    if (!spenderIsContract && allowance > 0n) flags.push("spender_is_eoa");
    if (exposure > 0n) flags.push("live_exposure");
    const result = {
      network: "base",
      token: t,
      owner: o,
      spender: s,
      allowanceRaw: allowance.toString(),
      allowance: unlimited ? "unlimited (~2^256)" : formatUnits(allowance, decimals),
      unlimited,
      spenderIsContract,
      currentExposure: formatUnits(exposure, decimals),
      verdict,
      flags,
      note:
        "Exposure = min(allowance, current balance): the max the spender could pull right now. " +
        "Unlimited approvals persist after your swap — revoke when done. Spender contract-verification " +
        "status needs an explorer API key (not checked here). This flags the allowance vector; it does not " +
        "prove intent.",
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`defi-guard-mcp v${VERSION} ready (rpc: ${RPC_URL ?? "public fallback pool"})`);
