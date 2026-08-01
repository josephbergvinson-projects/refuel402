# Bridge and destination-asset support

The product flow is defined in [`PRODUCT.md`](PRODUCT.md). This document records provider evidence, destination representations, and current support decisions.

## Rule

A bridge provider does not make an asset Refuel402-supported. The executable set is:

```text
provider route
∩ same-address delivery/activation proof
∩ exact Hedera representation
∩ Saucer route/liquidity policy
∩ x402 EVM exact compatibility
∩ destination sponsorship policy
```

Static candidates are in `config/support.testnet.json` and `config/support.mainnet.json`. Runtime probes may remove support; they may not silently promote a failed static policy candidate.

## Liquidity floor

`MIN_SAUCER_ROUTE_LIQUIDITY_USD` (default **$100** minimum pool liquidity on every hop of the selected route, either venue) is a runtime **execution gate** for `bridge_plus_refuel`, not a disclosure threshold. At this value it is a dead-pool filter and nothing more.

The floor is sized against the trade the product actually makes. `MAX_REFUEL_TINYBAR` caps a single refuel at 50 HBAR — about $3.31 at the HBAR/USD rate recorded in `config/whitelist.mainnet.json` — and the constant-product bound in `scripts/build-whitelist.ts` puts 150 bps of impact at that size at roughly 3,383 HBAR (~$224) of one-sided depth, i.e. ~$450 of balanced-pool TVL.

That is the deliberate consequence of a $100 floor: **between roughly $100 and $450 of pool TVL the floor admits routes that `MAX_PRICE_IMPACT_BPS` will reject at or near the maximum refuel.** Those assets stay quotable for the small refuels their pool can genuinely fill and are refused per amount rather than per asset — which is the point. The earlier $20,000 default rejected whole assets whose pools are orders of magnitude deeper than a $3 swap needs (LINK.axl, QNT, WAVAX, LCX among them). Operators who want refuel restricted to deep pools can raise the variable; nothing else about the pipeline changes.

Hydration and quote-time candidate selection prefer liquidity-eligible routes. When no eligible path exists the asset carries `SAUCER_LIQUIDITY_POLICY` and refuel is blocked — note that hydration also sets catalog `quote: false`, so in that case `/v1/product/quote` answers `409 PRODUCT_QUOTE_NOT_READY` rather than returning a quote body. The documented "quote with the blocker and `capabilities.execute: false`" shape is the *selected-route* re-check in `composeCombinedQuote`: it fires when hydration found an eligible path but the simulated winner came back below floor or with an unpriced hop. `bridge_only` is unaffected — the floor never disables an otherwise executable provider bridge.

The gates that scale with the trade are the real protection and run per quote: the venue-specific exact-output simulation, `MAX_PRICE_IMPACT_BPS` (default 150), the consented max slippage, and — because same-pool price impact cannot see a stale pool whose mid drifted from global spot — a fair-value deviation gate (`SAUCER_FAIR_VALUE_DEVIATION`, `MAX_QUOTE_FAIR_VALUE_DEVIATION_BPS`, default 300 bps) comparing the quote-implied HBAR price of the input token against SaucerSwap graph `priceUsd` and the network HBAR/USD rate; missing price evidence is disclosed as `fair_value_unverified`, never fabricated.

Measured against the public SaucerSwap V1 `/pools/full` graph on 2026-07-29, the direct WHBAR pool TVL (both sides, the same figure `liquidityUsd` computes) for the assets this floor was gating:

| Asset | Direct WHBAR pool TVL | ≥ $100 |
| --- | --- | --- |
| WBTC[hts] | $12,090 | yes (already passing) |
| WETH[hts] | $7,259 | yes — the LayerZero WETH representation the product bridges to is the separate ~$460 pool, which now also clears the floor and is bounded by price impact instead |
| WAVAX.axl | $1,330 | yes |
| LINK.axl | $1,319 | yes |
| QNT.axl | $1,207 | yes |
| LCX.axl | $597 | yes |
| WBNB.axl | $81 | no — ~$40 of one-sided depth cannot fill a 50 HBAR refuel at any acceptable impact |

Evidence strings recorded in `config/support.*.json` predate this change and still quote the $20,000 figure. They are historical readings, not policy, and live hydration replaces them whenever `SAUCERSWAP_API_KEY` is configured.

## Same-address bridge contract

The bridge request has one user account field. The adapter writes it into both:

```text
fromAddress = connected MetaMask account
toAddress   = connected MetaMask account
```

The resulting provider quote and transaction are rejected if either differs. No pasted Hedera destination is accepted.

## Provider selection contract

Provider is independent of token in both the UI and quote request:

- `Axelar / Squid` and `LayerZero / Stargate` are explicit scopes and never fall back to one another.
- `Auto` considers only quote-ready assets in the selected token’s declared comparison group, records every provider actually compared, and ranks real returned quotes by minimum retained destination amount, then fee and ETA.
- A missing credential, empty provider asset set, failed support predicate, or failed quote remains inspectable with a stable blocker; no static or synthetic quote is substituted. Stable runtime codes distinguish `PROVIDER_CREDENTIAL_MISSING`, `PROVIDER_NETWORK_UNCONFIGURED`, `PROVIDER_UNSUPPORTED_TOKEN_NETWORK`, `PROVIDER_ROUTE_UNAVAILABLE`, `STALE_QUOTE`, route/liquidity/mapping/contract/facilitator/sponsor failures, and disabled execution mode.
- Every successful adapter response is normalized into one source amount representation, destination token representation, provider-vs-gas/relayer fee classes, expected/minimum/slippage values, expiry, provider quote/route IDs, observation timestamp, and response hash. Auto compares only these eligible normalized live quotes.
- Requested provider, selected provider, asset, origin token/network, support evidence timestamp, provider quote ID, amount bounds, and expiry are part of the quote hash and PostgreSQL journey identity.

Current catalogs have no cross-provider comparison group with multiple executable candidates, so `Auto` is an honest inspectable scope rather than a fabricated route.

## Axelar / Squid

### Source and API evidence

- SaucerSwap’s canonical bridge source uses `@0xsquid/sdk`, MetaMask, and the same EVM address for `fromAddress` and `toAddress`.
- Current Squid v2 API calls require `x-integrator-id`.
- Refuel402 implements a server-side Squid v2 adapter. `SQUID_INTEGRATOR_ID` and environment-specific base URLs are never returned to the browser.
- The server-side Squid attribution identity is configured outside the browser bundle; a fresh Refuel wrapper quote returned an executable Ethereum USDC → Hedera mainnet USDC.axl transaction.

Primary sources:

- <https://docs.squidrouter.com/api-and-sdk-integration/sdk>
- <https://docs.squidrouter.com/api-and-sdk-integration/sdk/chains-tokens-balances>
- <https://github.com/axelarnetwork/axelar-contract-deployments>

### Hedera testnet

Axelar’s deployment config includes Hedera chain 296, GMP/ITS contracts, and an HTS interchain token:

| Asset | Destination representation | Provider state | Saucer state | Product state |
|---|---|---|---|---|
| AXE | HTS `0.0.9211548` / `0x…8c8e9c`, 6 decimals | Axelar ITS configured | No AXE/WHBAR, AXE/USDC, or AXE/SAUCE V2 pool at 500/1500/3000/10000 | Visible, disabled |

Precise conclusion: Axelar testnet support exists, but the bridge+Saucer product intersection is empty. “No bridge on testnet” is too broad; “no executable Refuel402 bridge route on testnet” is accurate.

Axelar’s Hedera checklist also says a recipient must be associated before transfer. Until a same-address lazy-arrival proof exists for an asset, it is classified `activation_required` or `arrival_unproven`, never assumed automatic.

### Hedera mainnet

The primary source-ready Axelar candidate is USDC.axl:

| Item | Evidence |
|---|---|
| Destination token | HTS `0.0.10285486`, `0x00000000000000000000000000000000009cf1ae`, 6 decimals |
| Token policy | No custom fees, KYC, freeze, or pause key in mirror readback |
| Saucer leg 1 | USDC.axl → native USDC, fee 500; about $115,181 TVL in authorized analytics readback |
| Saucer leg 2 | native USDC → WHBAR, fee 1500; about $4.69m TVL |
| Exact-output read | 3,319,952 USDC.axl base units for 50 HBAR at evidence time |
| Product state | Representation and both pool contracts re-verified; Squid mainnet quote passed. The exact Railway wrapper subsequently returned the live executable quote through the production Mirror call envelope. Mini-host public-Mirror throttling remains environment evidence, not a production blocker. |

Additional Axelar representations are admitted only after provider mapping plus live venue-specific Saucer simulation. The complete-graph API proves pools for QNT.axl, WAVAX.axl, WBNB.axl, LINK.axl, and LCX.axl. Squid's live inventory and route prove Ethereum LCX `0x8CD4…ae7E` → Hedera LCX `0.0.10483528`; its provider response expresses LCX in 18-decimal units, so Refuel records that raw domain and normalizes to the chain-authoritative 6-decimal HTS amount before affordability/conservation checks. LCX.axl has a direct V1 HBAR pool (`0.0.10493784`); a live exact-output V1 router read quoted 29.996834 LCX.axl for 10 HBAR at the 2026-07-26 evidence point. Thin liquidity remains disclosed and price-impact/slippage/retained-balance policy remains binding rather than being hidden behind a false no-route result. LINK's Saucer pool remains visible, but its independent Squid destination-route blocker is preserved.

The runtime must refresh provider quote and Saucer evidence before execution.

## LayerZero / Stargate

### Testnet

LayerZero’s authoritative metadata marks Hedera testnet active at EID 40285, but its Hedera testnet token catalog is empty. Stargate testnet metadata returns no Hedera asset.

Result: provider endpoint support exists; product asset support does not.

Primary sources:

- <https://docs.layerzero.network/v2/deployments/deployed-contracts>
- <https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/overview>
- <https://docs.layerzero.network/v2/developers/value-transfer-api/api-reference/quotes>
- <https://docs.stargate.finance/developers/protocol-docs/transfer>
- <https://github.com/stargate-protocol/stargate-v2/blob/main/packages/stg-evm-v2/src/interfaces/IStargate.sol>
- <https://metadata.layerzero-api.com/v1/metadata/deployments>
- <https://testnet.stargate-api.com/v1/metadata?version=v2>

Refuel402 uses the official LayerZero Value Transfer API only as a credentialed fallback for routes without a verified permissionless contract path. Public `GET /tokens` discovery is credential-free, but official `POST /quotes` and `GET /status/{quoteId}` require `LAYERZERO_TRANSFER_API_KEY`; the retired public Stargate quote API returns HTTP 410. Stargate’s current frontend does not expose a reusable credential: its generated client calls a same-origin `/api/vt` proxy, and direct external reuse returns HTTP 401 with an instruction to use the official API. Ethereum native ETH → Hedera WETH does not need that API: current official Stargate metadata and contracts prove asset-id 13 as Ethereum native Pool → Hedera OFT, and Refuel calls the permissionless `quoteOFT`, `quoteSend`, and `send` path directly. Mainnet WBTC and USDT0 use their own direct OFT adapters. All three routes verify route-specific code/token/EID/peer-or-token-messaging/path identity and track delivery through public LayerZero Scan. Provider-global readiness never substitutes for route-specific proof, and every route keeps the connected account as sender, recipient, and refund address.

### Mainnet WETH

| Item | Evidence |
|---|---|
| Provider | Permissionless Stargate V2 Fast / taxi through the official native pool and Hedera OFT |
| Source asset | Native ETH on Ethereum (`0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`), 18 decimals; native balance/value semantics, no ERC20 approval |
| Source contract | Stargate V2 native Pool `0x77b2043768d28E9C9aB44E1aBfC95944bcE57931`; `token()==0`, EID 30101, shared decimals 6, Hedera path credit live |
| Arrival contract/token | Stargate OFT `0xda6087E69C51E7D31b6DBAD276a3c44703DFdCAd` → ERC20 WETH `0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2`, 18 decimals, EID 30316 |
| Token messaging | Ethereum `0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980` ↔ Hedera `0x8a2B28364102Bea189D99A475C494330Ef2bDD0B`; bidirectional peers and bytecode verified |
| Saucer wrapper | `0.0.9675688` / `0x…93a3a8` |
| HTS counterpart | `0.0.9770617` / `0x…951679`, 8 decimals |
| Wrapper rate | `10,000,000,000` raw WETH units per HTS base unit |
| Saucer route | HTS WETH → WHBAR, fee 1500 exists, but authorized analytics showed about $463 TVL; the USDC pool had about $104 |
| Exact-output read | 178,737 HTS-WETH base units for 50 HBAR at evidence time (existence only, not liquidity acceptance) |
| Quote/transaction/status | Permissionless `quoteOFT` + `quoteSend`; `send` target is the native pool, selector `0xc7c7f5b3`, value is exact ETH principal + current native messaging fee, no approval; public LayerZero Scan status |
| Product state | `bridge_only` is quote-ready/executable through the route-specific on-chain adapter. `bridge_plus_refuel` is admitted only when the fresh hydrated Saucer graph and venue-specific exact-output simulation pass the liquidity floor, price-impact, slippage, affordability, and retained-asset policy; production readback accepted 0.001 ETH → 0.001 WETH with exact 0.01 HBAR, but with current pool depth the floor gates refuel (`SAUCER_LIQUIDITY_POLICY`) until real liquidity lands. The static fallback catalog remains conservative if current Saucer evidence is unavailable. The former WETH→WETH direct-OFT assumption is not used. |

Stargate metadata source:

- <https://mainnet.stargate-api.com/v1/metadata?version=v2>

### Mainnet WBTC

| Item | Evidence |
|---|---|
| Provider | LayerZero NativeOFT |
| Arrival token | Contract ERC20 `0xd7d4d91d64a6061fa00a94e2b3a2d2a5fb677849`, 8 decimals |
| Saucer wrapper | `0.0.9675688` / `0x…93a3a8` |
| HTS counterpart | `0.0.10082597` / `0x…99d925`, 8 decimals |
| Wrapper rate | `1` |
| Saucer route | HTS WBTC → native USDC, fee 1500 (about $23,773 TVL) → WHBAR, fee 1500 (about $4.69m TVL) |
| Exact-output read | 5,153 HTS-WBTC base units for 50 HBAR at evidence time |
| OFT path | Ethereum EID 30101 adapter `0x0555…2b9c` ↔ Hedera EID 30316 NativeOFT `0xd7d4…7849`; both `peers()` reads match and adapter `token()` returns canonical Ethereum WBTC |
| Quote/transaction proof | `quoteOFT` returns exact 8-decimal WBTC amount; `quoteSend` returns the live native messaging fee; transaction target is the verified adapter and calldata selector is OFT V2 `send` (`0xc7c7f5b3`) |
| Status/recovery | Public `https://scan.layerzero-api.com/v1/messages/tx/{sourceTxHash}`; only `DELIVERED` + destination `SUCCEEDED` confirms arrival, while blocked/failed/stored-payload states fail closed |
| Token policy | HTS WBTC has no admin, freeze, KYC, or pause key; wrapper `0.0.9675688` is treasury and controls supply/wipe for mint/burn; freeze default is false |
| Product state | Direct OFT quote/status and exact wrapper execution are source-ready. Fresh complete-graph evidence on 2026-07-23 found two liquidity-eligible V2 routes; selected HTS-WBTC → USDC → WHBAR had a $23,981 minimum-liquidity leg and quoted 112 HTS-WBTC base units for exactly 1 HBAR. The deployed mainnet generation later completed a terminal WBTC → 25 HBAR journey; the newer local proxy source remains undeployed. |

LayerZero metadata source:

- <https://metadata.layerzero-api.com/v1/metadata>

### USDT0

LayerZero metadata exposes HTS USDT0 `0.0.10282787` / `0x…9ce723` and Hedera OFT `0xe311…53d6`. The official Ethereum USDT adapter is `0x6C96…1dee`; live reads prove its canonical USDT token, required approval, bidirectional Hedera peer, `quoteOFT`, `quoteSend`, and exact OFT `send` calldata. Historical authorized analytics showed about $354,068 TVL in USDT0/USDC, and the configured Saucer route is USDT0 500 → native USDC 1500 → WHBAR.

Mirror readback also exposes an administrator key and freeze key. Those facts remain in internal diagnostics and quote evidence, but they are not provider-route failures, consumer badges, or execution blockers for an otherwise executable USDT0 route.

## Contract ERC20 versus HTS

WETH/WBTC do not arrive as the HTS assets used by Saucer pools. The correct destination sequence is:

1. x402 fee in the raw contract token through Permit2;
2. exact allowance to the Saucer ERC20 wrapper;
3. wrap raw token to the configured HTS counterpart using the on-chain rate;
4. exact-output Saucer swap from HTS counterpart to WHBAR/HBAR;
5. verify retained raw/HTS balances and HBAR receipt.

The wrapper is never inferred by symbol. Activation associates the configured HTS counterpart, wrapper approval is bounded to the raw ERC20 debit, `wrap(erc20Token, recipient, amount)` is separately authorized with selector `0x62355638`, and Router approval/swap are bounded in HTS units after applying the on-chain rate.

## Dated route and credential proofs

The 2026-07-22 credential/contract evidence and 2026-07-23 direct-WBTC/complete-graph evidence remain valid component proofs. Current execution readiness still requires fresh same-release runtime readback.

Current evidence records:

- testnet and mainnet Permit2/refuel-authorization proxy deployments are bytecode- and immutable-verified; mainnet Permit2 is `0x71304d9943C9d46A18cB6238759800320540F0e4` and the current mainnet proxy is `0x91d81fbAf684482a9db0195C0d8d5bDc4880b2b4`, which has executed completed mainnet refuels;
- the Saucer API integration loads the complete V1+V2 token/pool graph and enumerates bounded non-cyclic discovery paths. Executable comparison supports bounded single-venue V1 router and V2 QuoterV2 exact-output simulation; mixed-venue paths remain unsupported;
- the 2026-07-26 complete-graph proof observed 2,677 V1 pools and 55 V2 pools. LCX.axl selected V1 pool `2772` / contract `0.0.10493784`; QNT.axl, LINK.axl and WAVAX.axl also returned authoritative pool evidence;
- Hedera documents `/api/v1/contracts/call` on the public Mirror REST service with no authentication and a published 50-RPS/IP throttle. Refuel uses the current official host and SaucerSwap's full production call envelope (`method`, caller, gas, gas price, estimate flag, value), serializes simulations, applies 50–5000 ms spacing, honors `Retry-After`, retries HTTP 429 at most once, and hard-stops after a second 429. The exact Railway wrapper has returned a live mainnet quote; Mini-host throttling remains a host-local limitation rather than a contradictory production verdict;
- graph/token/pool, derived-route, and short quote caches have bounded TTL/entry limits. Identical graph and quote requests coalesce in flight. Exact simulations are globally serialized, spaced, and limited to two read-only 429 attempts honoring `Retry-After` with capped jittered backoff before an architecture hard stop;
- simulation freshness is independent of graph freshness. The combined quote expires at the earliest bridge, x402, or Saucer simulation expiry, and stale quotes cannot become executable through a graph-cache hit;
- desired HBAR is explicit and quote-bound. The server solves a conservative maximum on the selected venue-aware exact-output route with a fixed total candidate budget, one timestamped gas/HBAR market snapshot, preserved Mirror rate controls, and an exposed unresolved tinybar interval;
- route and cost evidence are typed: ordered token/pool/fee/liquidity hops, wrapper/WHBAR boundaries, unit-scoped conservation, and funding-source rows that prevent provider/native-value, wrapper, slippage, price-impact or sponsor costs from being counted twice.

Credential names are deliberately distinct: the host general secret is `SAUCERSWAP_PUBLIC_API_KEY`; Refuel consumes `SAUCERSWAP_API_KEY` through a no-output alias/secret-injection contract. A reconciled fresh probe of the canonical owner-only host secret against `https://api.saucerswap.finance/tokens` with `x-api-key` returned HTTP 200 and 1,529 token rows on 2026-07-22. The earlier 401 closeout contradicted proven QA evidence and was not a durable credential verdict. The key enables complete-graph reads; exact-output simulation uses Hedera's public Mirror contract-call endpoint by default.

## x402 compatibility

Read-only probes found no EIP-2612 or EIP-3009 surface on Axelar HTS USDC, LayerZero WETH, or LayerZero WBTC. The uniform EOA payment method is Permit2.

Current deployment state:

- Hedera testnet: Permit2 and the verified exact proxy are deployed at the addresses recorded in `contracts/deployments.json`.
- Hedera mainnet: Refuel402 Permit2 is deployed at `0x71304d9943C9d46A18cB6238759800320540F0e4`; the current full-route refuel-authorization proxy is deployed at `0x91d81fbAf684482a9db0195C0d8d5bDc4880b2b4`. Runtime bytecode and Permit2/facilitator immutables are verified, and pre-authorized refuels have completed against it on mainnet (`0x2b04b7b79f286e46de31fb4997ab8d565fbfad1cd3c2cce48497bd8c7638a40b`).

The browser does not use upstream x402's hard-coded canonical Permit2/proxy pair. It signs the Refuel402 `PermitWitnessTransferFrom` domain against the network-specific deployed Permit2 and binds the custom proxy, payer, token, amount, recipient, chain, nonce, deadline, and quote context hash. The exact product wrapper proves challenge creation, typed-data verification, settlement, replay rejection, sponsored destination intents, and terminal reconciliation. Completed wallet-authorized mainnet journeys establish `live_proof` for the deployed generation; the current local contract correction remains at local/integration acceptance until separately deployed and read back.

## Provider error handling

Adapters expose stable classes only:

- provider credential missing;
- provider network/base route unconfigured;
- provider token/network unsupported;
- route unavailable;
- stale quote;
- response invalid;
- request failed.

They do not return provider headers, integrator IDs, response bodies, or internal stack traces to the browser.

## Runtime support refresh

A production options/quote request should refresh or validate:

1. provider chain/token/route status;
2. exact destination token and wrapper mapping;
3. token keys/custom fees;
4. pool existence and QuoterV2 output;
5. price impact and liquidity policy;
6. Permit2/proxy/facilitator code/support;
7. policy-RPC target readiness;
8. mode/mainnet gate.

Any mismatch produces a disabled reason and no transaction.
