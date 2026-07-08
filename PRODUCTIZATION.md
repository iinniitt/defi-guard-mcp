# defi-guard-mcp → producto de seguridad freemium (roadmap Pierna 1)

Objetivo: convertir el MCP publicado (3 tools de datos DeFi) en el **"guard antes de firmar"** — el lane menos saturado (investigación 2026-07-07): seguridad para agentes/usuarios que hacen DeFi, medido/freemium. Empaquetar, no I+D.

## Posicionamiento
"La capa de seguridad que revisa una transacción/token DeFi ANTES de que el agente (o tú) firme." Se PAREA con MCPs de ejecución (Haiku, Voidly), no compite. Moat = juicio de seguridad real (Solidity/audit/MEV), difícil de fingir por wrappers.

## Herramientas (estado → objetivo)
Actuales: `aave_position_health`, `quote_swap`, `token_risk_snapshot` (ya detecta honeypot parcial vía round-trip).
NUEVAS (guard-before-signing, todas on-chain, sin API key salvo donde se note):
1. ✅ **`token_safety_screen`** (HECHO+VERIFICADO 2026-07-08): ownership renunciada (owner()==0) + honeypot/sell-tax (compra→venta) + veredicto + flags. Smoke-test live OK.
2. ✅ **`scan_dangerous_capabilities`** (HECHO+VERIFICADO): bytecode selector scan (mint/pause/blacklist/setFees/setTaxes/setMaxTx/upgradeTo) → "el owner PUEDE hacer X" + detección de proxy. Live OK (USDC→upgradeTo detectado; WETH9→limpio).
3. ✅ **`approval_risk`** (HECHO+VERIFICADO): allowance(owner,spender) + flag ilimitada + exposure=min(allowance,balance) + spender contrato/EOA. Live OK.
   → **6 tools totales. ✅ PUBLICADO 2026-07-08: npm v0.2.0 + GitHub push + registro MCP oficial v0.2.0 (los 3 canales verificados).**
4. **`assess_tx`** (v2, pendiente): dado calldata/tx, simular en fork y flag drenajes/approvals ocultas. Mayor lift.
5. (Opcional, con Basescan API key del usuario) `contract_verified`: ¿verificado en el explorer? Requiere key → gate usuario.

## Metering / freemium (andamiaje ahora, cobro cuando el usuario conecte rail)
- stdio MCP no puede cobrar server-side. Dos caminos:
  - **Free tier local**: el MCP corre local, gratis, con límite suave (N checks/día vía contador en disco) — para ranking en Smithery/Glama y lead-gen.
  - **Paid hosted**: versión hosted detrás de x402 (per-call, USDC, rail nativo agentes) o API key + Polar (suscripción). El usuario crea la cuenta; yo dejo el código wired (header de API key / middleware x402).
- ✅ HECHO (2026-07-08): `src/metering.ts` — contador diario local (~/.defi-guard/usage.json), tools premium (scan_dangerous_capabilities, approval_risk) con soft-limit 25/día en free, `DEFI_GUARD_TIER=pro` o `DEFI_GUARD_LICENSE_KEY` = ilimitado. **Enforcement OFF por defecto** (`DEFI_GUARD_METERING=on` lo activa) para no degradar la UX antes de que exista forma de comprar Pro. Fail-open en todo caso ambiguo. Testeado: límite, bypass pro, off-por-defecto. Se activará junto con el rail de cobro.

## Precio (de la investigación)
- Free: N checks/mes (ranking + lead-gen). Pro: **$0.01-0.05 por check** (x402 per-call) o **$29-99/mo** (Polar suscripción teams/agent-operators). Skill de audit aparte $12-30.

## Distribución
Ya publicado (npm + registro MCP + mcp.so + awesome-mcp PR). Añadir: rankear en Smithery/Glama con free tier real; publicar la metodología de detección (build-in-public) como funnel hacia el servicio de pre-audit (Pierna 1 mayor). MCP registry = discovery, NO revenue (monetizar vía propio billing).

## Gate del usuario (recordatorio)
- Cuenta Polar.sh o Stripe (cobro) — solo cuando haya Pro listo.
- (Opcional) Basescan API key para `contract_verified`.
- Nada de esto bloquea construir las tools y el andamiaje freemium ahora.
