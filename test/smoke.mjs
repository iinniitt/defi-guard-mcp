// Smoke test: spawns the built server over stdio as a real MCP client and
// exercises all three tools against live Base state.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Aave V3 Base pool contract itself — guaranteed valid address; expect "no position".
const SOME_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
if (tools.tools.length !== 3) throw new Error("expected 3 tools");

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text;
  if (!text) throw new Error(`${name}: empty response`);
  const parsed = JSON.parse(text);
  console.log(`\n== ${name} ==\n`, JSON.stringify(parsed, null, 2).slice(0, 900));
  return parsed;
}

const health = await call("aave_position_health", { address: SOME_ADDRESS });
if (typeof health.hasPosition !== "boolean") throw new Error("health: bad shape");

const quote = await call("quote_swap", { tokenIn: WETH, tokenOut: USDC, amountIn: "0.1" });
if (!quote.amountOut || Number(quote.amountOut) <= 0) throw new Error("quote: no output");
const px = Number(quote.amountOut) / 0.1;
if (px < 500 || px > 20000) throw new Error(`quote: implied ETH price ${px} USD looks wrong`);

const risk = await call("token_risk_snapshot", { token: USDC });
if (risk.symbol !== "USDC") throw new Error("risk: wrong token metadata");
if (!risk.depthProbe?.small?.tradable) throw new Error("risk: USDC should be tradable");

console.log("\nSMOKE OK — implied ETH price:", px.toFixed(0), "USD; USDC round-trip loss:",
  risk.depthProbe.small.roundTripLossPct + "%");
await client.close();
