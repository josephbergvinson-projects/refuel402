# Refuel402 — Hedera x402 bounty submission note

## Project

Refuel402 lets an EVM user bridge an asset to Hedera and arrive with an exact amount of HBAR for gas in one stock-MetaMask flow. The same EVM address is the bridge sender, Hedera destination, payment authorizer, conversion sender, and HBAR recipient.

- Public source: <https://github.com/josephbergvinson-projects/refuel402>
- Public app: <https://refuel402.pages.dev/>
- Public demo: <https://drive.google.com/drive/folders/1jitCwXlTOeT_wffuPbCLswKwGLNcjD-2> — anonymously readable 94.628-second `Refuel402 Demo.mp4`
- License: MIT

## Problem solved

Hedera charges gas only in HBAR. A user who bridges USDC, WETH, or WBTC while holding no HBAR can arrive with assets they cannot approve, swap, or even associate. Every workaround that says “obtain HBAR first” assumes the destination access the user is missing.

Refuel402 composes the provider route, exact Hedera token representation, account activation, bounded payment authorization, SaucerSwap exact-output conversion, gas sponsorship, retained balance, and durable recovery before the origin transaction is sent.

## How it works

1. The user selects `bridge_only` or `bridge_plus_refuel`, provider, origin network, asset, source amount, and desired HBAR.
2. The server returns a provider-bound quote with destination representation, Saucer V1/V2 route evidence, price impact, slippage, retained balance, service fee, sponsor exposure, and explicit blockers.
3. One EIP-712 `SourceLegConsent` binds the owner to the journey and quote.
4. For the pre-authorized route, MetaMask signs a bounded Permit2 allowance and `RefuelAuthorization` before the bridge. The witness binds owner, token, maximum input, exact HBAR, service fee, recipient, journey nonce, deadline, and complete route hash.
5. After authoritative arrival, the executor can call the atomic proxy only within those signed terms. Any unused amount is refunded, and provider, chain, balance, sponsor, and PostgreSQL evidence are reconciled before completion.

## x402 boundary

Refuel402 keeps two related payment paths explicit:

- **Manual destination conversion:** the product payment endpoint issues and settles an HTTP 402 `exact` Permit2 challenge through the self-hosted facilitator before sponsored conversion intents.
- **Pre-authorized atomic refuel:** the bounded service fee is collected inside `executeRefuel` with the swap and refund. It uses the same Permit2 witness discipline but does not perform a second HTTP 402 round trip after arrival.

The public `/.well-known/x402` manifest describes the manual HTTP resource and reports runtime readiness by network. The pre-authorized fee path is documented separately rather than presented as a standard challenge/settlement exchange.

## Mainnet proof

Acceptance level: **`live_proof` for the deployed mainnet generation**. Four stock-MetaMask journeys completed with exact HBAR delivery and terminal reconciliation.

The showcase run is **Ethereum WBTC → Hedera WBTC → 25 HBAR** over LayerZero and a two-hop SaucerSwap V2 route:

| | Ethereum origin | Hedera arrival | Hedera conversion |
|---|---|---|---|
| **WBTC → 25 HBAR** | [`0xe0a5707d…182d6b`](https://etherscan.io/tx/0xe0a5707d550149c6275d3319a0ccc5c796ade5e5a483779f26b0da08bd182d6b) | [`0xaa81e12a…0ae996`](https://hashscan.io/mainnet/transaction/0xaa81e12aeb13523104c1d9c4f3228fd503b68fb74a4eab4909620c10b20ae996) | [`0xeb37c19d…2f4a59`](https://hashscan.io/mainnet/transaction/0xeb37c19d8a403bc9e9b70d006fba272f1c8be6a2d12810068c012220d62f4a59) |
| **USDC.axl → 25 HBAR** (Axelar/Squid, HTS-native) | [`0xa4221220…d2c65`](https://etherscan.io/tx/0xa42212208f776d882d95ac3fd96688a0d0e29c839abd293acbeaa687e5dd2c65) | [`0.0.6319439-…530857`](https://hashscan.io/mainnet/transaction/0.0.6319439-1785596596-362530857) | [`0x88564c2b…b3abc3`](https://hashscan.io/mainnet/transaction/0x88564c2b00d49095a480df91d10259028d009a8d849bc2ddb5bbcca3eeb3abc3) |
| ETH → WETH → 10 HBAR | [`0x49d9b250…1bbee4`](https://etherscan.io/tx/0x49d9b2509c05e49ca720f463e89de6a776089e71bd1542fc4e0541e0e81bbee4) | [`0x7f4208d5…bb5ede`](https://hashscan.io/mainnet/transaction/0x7f4208d5c5072a78acff387cad9be51245409d64a8f81749e4aa3ca77ebb5ede) | [`0xe14f5c3c…0a2654`](https://hashscan.io/mainnet/transaction/0xe14f5c3cfa98dde940806dfdc705e3fc0b3471444e392150e3c05b65cb0a2654) |
| ETH → WETH → 10 HBAR | [`0x7af13c82…caf58a`](https://etherscan.io/tx/0x7af13c82fa23a3b8c38065f11137f734b804791c6a1780e48bd45f7462caf58a) | [`0x57c034b1…a2f30`](https://hashscan.io/mainnet/transaction/0x57c034b1d5e03c04bbf3e71f790671a018e689518686816d734a0c984b7a2f30) | [`0x2b04b7b7…38a40b`](https://hashscan.io/mainnet/transaction/0x2b04b7b79f286e46de31fb4997ab8d565fbfad1cd3c2cce48497bd8c7638a40b) |

On the WBTC run, `RefuelExecuted` records a signed cap of 4,585 satoshi-WBTC, 3,636 spent (926 service fee + 2,710 swap input), 949 refunded, and `hbarDelivered = 2500000000` tinybar—exactly 25 HBAR. The owner signed nothing after the bridge.

## Testnet limitation

The complete provider→asset→SaucerSwap intersection does not currently exist on Hedera testnet:

- Axelar ITS reaches Hedera testnet and AXE exists, but AXE has no qualifying Saucer route.
- LayerZero has a Hedera testnet messaging endpoint but publishes no official Hedera testnet asset.

The full journey is therefore not currently executable on testnet. This is a formal judging risk, and the mainnet proof is presented as real product evidence rather than mislabeled testnet compliance.

Available testnet evidence is narrower:

- the chain-296 path, support catalog, facilitator configuration, policy RPC, and product mode are implemented;
- the current testnet proxy is deployed and runtime/immutable-verified at `0xDC1E48E6b365487514447A66dA20E8b8B58a26C3`;
- a [0.1-HBAR pre-authorized refuel](https://hashscan.io/testnet/transaction/0.0.9690264-1785459001-065566567) completed on a superseded proxy generation;
- a separate 900-HBAR testnet SaucerSwap transaction proves routing/liquidity, not x402 or the whole product.

No current-bytecode whole-product testnet execution is claimed.

## Current source and verification

The source in this repository is newer than the deployed generation. It replaces absolute proxy-balance assertions with per-attempt balance deltas, preventing an unrelated one-unit token donation from blocking future refuels. The corrected source is locally verified but **not deployed**; `contracts/deployments.json` keeps the pending source hash separate from the immutable deployed source hash and receipts.

The public source includes:

- executable Anvil tests against the exact tracked compiled proxy bytecode and ABI;
- raw-token and wrapper-HTS pre-existing donation cases;
- replay, deadline, route binding, fee/cap, refund, exact/minimum output, revert atomicity, and no-new-dust assertions;
- a PostgreSQL product harness covering `refuelCap` → capped Permit2 approval → `RefuelAuthorization` → wallet boundary → bridge ordering;
- deterministic browser, API, contract, and production-build gates.

The exact `npm run check` wrapper runs the Vitest suite, typecheck, deterministic contract compile and verification, a component smoke pass that executes every rendered component, the integration harness, the product harness, the browser-faithful harness, and the production web build. It contains no EVM execution test — the contract's runtime behaviour is carried by the mainnet journeys above, and that is stated rather than implied. Release acceptance ran this wrapper twice. The product proof ended `completed` with one payment, no refresh wallet prompts, and exactly three destination-quote events: the initial post-arrival quote plus router-approval and router-execution refreshes. Permit2 setup correctly uses its own authorization runway and creates no stale fourth market refresh.

## Known limits

- No qualifying provider-to-Saucer intersection currently makes the full product executable on Hedera testnet.
- The donation-resistant source in this repository has not been deployed; existing proxy addresses remain on the deployed source hash recorded in `contracts/deployments.json`.
- LCX uses a SaucerSwap V1 route and remains on the manual conversion path.
- QNT fails safe when its live route cannot be resolved.
- Wrapper assets may refund unused slippage headroom as the 1:1 HTS wrapper token.
- Unsigned quote/journey creation can add inert Activity rows for another address, but every source mutation remains owner-consent gated.

## Security model

The browser never receives provider credentials, sponsor keys, raw signed transactions, or database credentials. Unsupported or ambiguous state fails closed. Unknown submissions are never blindly retried. Contract authorization is one-time and route-bound; source mutations require owner consent; PostgreSQL retains immutable events and submission evidence for recovery.

See [`docs/PRODUCT.md`](docs/PRODUCT.md), [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/BRIDGES.md`](docs/BRIDGES.md), and [`docs/PRODUCTION.md`](docs/PRODUCTION.md).
