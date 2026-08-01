# Refuel402

Refuel402 is a one-wallet bridge and optional-refuel flow for Hedera. A user connects stock MetaMask, bridges an EVM asset to the same address on Hedera, and can arrive with an exact amount of HBAR for gas.

- Source: <https://github.com/josephbergvinson/refuel402>
- App: <https://refuel402.pages.dev/>
- Demo: <https://drive.google.com/drive/folders/1jitCwXlTOeT_wffuPbCLswKwGLNcjD-2> — public 94.628-second `Refuel402 Demo.mp4`
- Bounty summary: [`SUBMISSION.md`](SUBMISSION.md)
- License: MIT

The authoritative product contract is [`docs/PRODUCT.md`](docs/PRODUCT.md).

## Why this matters for Hedera

Hedera charges gas only in HBAR. A user who bridges USDC, WETH, or WBTC while holding no HBAR can arrive with assets they cannot approve, swap, or even associate. The usual workaround—obtain HBAR elsewhere—assumes the destination access the user is missing.

Refuel402 makes the bridge flow deliver usable funds. The same MetaMask account is the origin sender, Hedera destination, payment authorizer, conversion sender, and HBAR recipient. Account activation, token representation, exact-output conversion, sponsorship, and recovery are composed before the origin transaction is sent.

## How it uses x402

Refuel402 keeps two related payment paths explicit:

- **Manual destination conversion:** `POST /v1/product/journeys/:id/payment` issues and settles an HTTP 402 `exact` Permit2 challenge through the self-hosted facilitator before sponsored conversion intents.
- **Pre-authorized atomic refuel:** before bridging, the owner signs a bounded `RefuelAuthorization` Permit2 witness. Its service fee is collected inside the atomic `executeRefuel` swap-and-refund call, not through a second HTTP 402 round trip after arrival.

Both paths bind payer, token, amount, recipient, chain, nonce, deadline, spender, and quote context. The pre-authorized witness additionally binds the exact route hash, maximum input, exact HBAR output, and fixed service fee. If those terms cannot be satisfied, execution reverts atomically.

### The fee, on a real journey

The USDC.axl run below is the worked example. Its on-chain `RefuelExecuted` event:

```
spent               2,300,380 USDC.axl   (2.30038)
  x402 service fee    546,504 USDC.axl   (0.546504)
  swap input        1,753,876 USDC.axl
refunded              319,007 USDC.axl
hbarDelivered   2,500,000,000 tinybar    (exactly 25 HBAR)
```

The fee is denominated by the x402 quote, priced in the asset that just arrived — the only asset the owner holds — and paid to the x402 recipient by `Refuel402ExactPermit2Proxy` against the Permit2 witness signed before bridging. `spent + refunded` equals the signed cap exactly.

So the completed mainnet journeys prove the x402 **scheme, witness, payment proxy and fee settlement**. They do not exercise the HTTP transport, because the pre-authorized path deliberately does not use it: an owner waiting 20 minutes on a bridge, holding no gas on the destination chain, cannot be asked to come back and answer a `402`. The manual path still settles that way, and `POST /v1/product/journeys/:id/payment` returns a live `@x402/core`-encoded `PAYMENT-REQUIRED` challenge today — but no mainnet journey has yet completed through it, so it is proven at integration-harness level and stated as such.

## Why the complete proof is on mainnet

The full provider→asset→SaucerSwap intersection does not currently exist on Hedera testnet. Axelar ITS reaches Hedera testnet and AXE exists, but AXE has no qualifying Saucer route. LayerZero has a Hedera testnet messaging endpoint but publishes no official Hedera testnet asset. The UI reports those blockers instead of pretending the journey is executable.

This is a formal judging risk: the complete end-to-end evidence is on mainnet. The repository still includes chain-296 support, a deployed and verified testnet proxy, deterministic testnet integration coverage, a superseded-proxy 0.1-HBAR testnet refuel receipt, and a separate 900-HBAR testnet SaucerSwap receipt. None is described as current-bytecode whole-product testnet proof.

## Product invariants

- One injected MetaMask EOA is the bridge sender, Hedera destination, x402 payer, conversion sender, and HBAR recipient.
- `bridge_only` remains independent of SaucerSwap and makes no HBAR claim; `bridge_plus_refuel` adds the route, payment, sponsor, retained-balance, and exact-output gates.
- The browser uses `eth_sendTransaction` and `eth_signTypedData_v4`; it never requests raw transaction signing or native Hedera signing.
- Unsupported candidates remain visible with specific reasons.
- Unknown external results are never blindly retried.
- Provider, database, facilitator, and sponsor credentials remain server-side.

## Current acceptance

Acceptance level: **`live_proof` for the deployed mainnet generation**. Four stock-MetaMask journeys completed with the exact requested HBAR and terminal reconciliation, across both bridge providers and both destination token standards.

The showcase run is **Ethereum WBTC → Hedera WBTC → 25 HBAR** over LayerZero and a two-hop SaucerSwap V2 route:

| | Ethereum origin | Hedera arrival | Hedera conversion |
|---|---|---|---|
| **WBTC → 25 HBAR** | [`0xe0a5707d…182d6b`](https://etherscan.io/tx/0xe0a5707d550149c6275d3319a0ccc5c796ade5e5a483779f26b0da08bd182d6b) | [`0xaa81e12a…0ae996`](https://hashscan.io/mainnet/transaction/0xaa81e12aeb13523104c1d9c4f3228fd503b68fb74a4eab4909620c10b20ae996) | [`0xeb37c19d…2f4a59`](https://hashscan.io/mainnet/transaction/0xeb37c19d8a403bc9e9b70d006fba272f1c8be6a2d12810068c012220d62f4a59) |
| **USDC.axl → 25 HBAR** (Axelar/Squid, HTS-native) | [`0xa4221220…d2c65`](https://etherscan.io/tx/0xa42212208f776d882d95ac3fd96688a0d0e29c839abd293acbeaa687e5dd2c65) | [`0.0.6319439-…530857`](https://hashscan.io/mainnet/transaction/0.0.6319439-1785596596-362530857) | [`0x88564c2b…b3abc3`](https://hashscan.io/mainnet/transaction/0x88564c2b00d49095a480df91d10259028d009a8d849bc2ddb5bbcca3eeb3abc3) |
| ETH → WETH → 10 HBAR | [`0x49d9b250…1bbee4`](https://etherscan.io/tx/0x49d9b2509c05e49ca720f463e89de6a776089e71bd1542fc4e0541e0e81bbee4) | [`0x7f4208d5…bb5ede`](https://hashscan.io/mainnet/transaction/0x7f4208d5c5072a78acff387cad9be51245409d64a8f81749e4aa3ca77ebb5ede) | [`0xe14f5c3c…0a2654`](https://hashscan.io/mainnet/transaction/0xe14f5c3cfa98dde940806dfdc705e3fc0b3471444e392150e3c05b65cb0a2654) |
| ETH → WETH → 10 HBAR | [`0x7af13c82…caf58a`](https://etherscan.io/tx/0x7af13c82fa23a3b8c38065f11137f734b804791c6a1780e48bd45f7462caf58a) | [`0x57c034b1…a2f30`](https://hashscan.io/mainnet/transaction/0x57c034b1d5e03c04bbf3e71f790671a018e689518686816d734a0c984b7a2f30) | [`0x2b04b7b7…38a40b`](https://hashscan.io/mainnet/transaction/0x2b04b7b79f286e46de31fb4997ab8d565fbfad1cd3c2cce48497bd8c7638a40b) |

On the WBTC run, `RefuelExecuted` records a signed cap of 4,585 satoshi-WBTC, 3,636 spent (926 service fee + 2,710 swap input), 949 refunded, and `hbarDelivered = 2500000000` tinybar—exactly 25 HBAR. The owner signed nothing after the bridge.

## Current source versus deployed evidence

The source in this repository is newer than the deployed generation. It replaces absolute proxy-balance assertions with per-attempt deltas against captured entry baselines, so an unrelated one-unit token donation cannot block future refuels. Executable Anvil tests exercise the exact tracked bytecode and ABI across raw-token and wrapper-token donations, replay, deadline, route binding, cap, fee, refund, minimum output, revert atomicity, and no-new-dust invariants.

**This donation-resistant source is locally verified but not deployed.** `contracts/deployments.json` keeps its pending source hash separate from the immutable deployed source hash and receipts.

The exact `npm run check` wrapper covers the Vitest suite, typecheck, deterministic contract compile and verification, a component smoke pass that executes every rendered component, the integration harness, the product harness, the browser-faithful harness, and the production web build. It does **not** include an EVM execution test — `server/test/contracts.test.ts` asserts on contract source and artifact hashes, and the contract's runtime behaviour is carried by the mainnet journeys above. The product harness records a completed journey with exactly three destination-quote events: the initial post-arrival quote plus one refresh for router approval and one for router execution. Permit2 setup uses its own authorization runway and does not add a stale fourth refresh.

## Known limits

- No qualifying provider-to-Saucer intersection currently makes the full product executable on Hedera testnet.
- The donation-resistant source in this repository has not been deployed; existing proxy addresses remain on the deployed hash recorded in `contracts/deployments.json`.
- LCX uses a SaucerSwap V1 route and remains on the manual conversion path.
- QNT fails safe when its live route cannot be resolved.
- Wrapper assets may refund unused slippage headroom as the 1:1 HTS wrapper token.
- Unsigned quote/journey creation can add inert Activity rows for another address, but every source mutation remains owner-consent gated.

## Architecture

```text
stock MetaMask EOA
  │
  ├─ origin bridge tx ── provider ──> same EVM address on Hedera
  │
  ├─ EIP-712 x402 exact / Permit2 ──> self-hosted facilitator
  │
  └─ eth_sendTransaction ──> policy RPC ──> bounded HAPI sponsor
                                   │
                                   ├─ destination activation/association
                                   ├─ Permit2 approval
                                   ├─ ERC20→HTS wrap when required
                                   └─ SaucerSwap exact-output swap → HBAR
```

The existing HAPI sponsor, calldata policy, pricing, mirror reads, and PostgreSQL lifecycle controls are reused behind the MetaMask-compatible RPC boundary. Browser-uploaded raw bundles and native Hedera x402 remain isolated legacy technical APIs, not the product acceptance path.

## Product APIs

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/v1/product/options?mode=testnet|mainnet` | Networks, providers, assets, and independent bridge-only/refuel support states. |
| `POST` | `/v1/product/quote` | `bridge_only` provider-arrival quote or `bridge_plus_refuel` exact-output quote; Auto preserves the selected asset. |
| `GET` | `/v1/product/quotes/:id` | Read the immutable persisted quote/provider/support identity. |
| `GET` | `/v1/product/journeys?account=&limit=&before=` | Read a bounded account-scoped Activity page; never selects or mutates a journey. |
| `POST` | `/v1/product/journeys` | Persist an executable stored quote as an idempotent PostgreSQL journey; no chain mutation. |
| `GET` | `/v1/product/journeys/:id` | Pure read of the authoritative quote/journey/events/submissions plus a no-auto-sign/no-auto-resubmit recovery decision. |
| `GET` | `/v1/product/journeys/:id/events` | Read ordered immutable lifecycle history. |
| `GET` | `/v1/product/journeys/:id/submissions` | Read durable submission attempts and unknown/terminal results. |
| `POST` | `/v1/product/journeys/:id/wallet-boundary` | Persist the pre-approval/pre-bridge consent boundary so refresh cannot trigger a blind replay. |
| `POST` | `/v1/product/journeys/:id/destination-quote` | Explicitly mint/reuse a live post-arrival quote; GET never creates one. |
| `POST` | `/v1/product/journeys/:id/reconcile-submissions` | Resolve review state from mirror evidence only; ambiguous evidence remains blocked and nothing is resubmitted. |
| `POST` | `/v1/product/journeys/:id/bridge/adopt` | Bind a lost source hash only after EIP-712 owner consent, provider confirmation, and one unbound matching destination credit. |
| `POST` | `/v1/product/journeys/:id/payment` | Create/verify/persist one quote-bound x402 payment through the currently probed facilitator and deployed network contracts. |
| `POST` | `/v1/product/journeys/:id/intents/:kind/authorize` | Persist one exact quote-bound policy-RPC authorization; runtime target, sponsor, gas, reserve, expiry and execution-mode gates remain authoritative. |
| `GET` | `/v1/product/policy-rpc` | Policy-RPC capability and authorization contract. |
| `POST` | `/rpc/testnet` or `/rpc/mainnet` | Read RPC proxy; writes require an exact one-time authorization and live submitter. |
| `GET` | `/v1/account/:idOrAddress` | Read-only Hedera account/hollow/balance inspection. |
| `GET` | `/v1/health` | Service health. |

Legacy technical endpoints such as `/v1/refuel/plan`, `/v1/quote`, and `/v1/fuel` are retained for non-browser regression/agent work only.

## Local development

```bash
cp .env.example .env
npm install
npm test
npm run typecheck
npm run build:web
npm run server
```

Open `http://localhost:4020`.

A source-only run does not need provider or sponsor credentials. The product UI will show real support candidates and fail closed when a live capability is absent.

## Configuration

Important server-only groups are documented in [`.env.example`](.env.example):

- Squid/Axelar provider route
- SaucerSwap developer API route
- EVM x402/Permit2/facilitator readiness
- policy-RPC authorization/submission readiness
- sponsor and PostgreSQL lifecycle
- explicit mainnet execution gate

Do not put API keys, sponsor keys, or facilitator keys in any `VITE_*` variable.

## Verification

```bash
npm run check
npm run e2e:product-harness
npm run contracts:evm-test
```

`npm run check` runs the test suite, typecheck, deterministic contract compile/verification, a component smoke pass, the integration harnesses, the browser-faithful harness, and the web build. There is no EVM execution test; see Known limits. By default `e2e:product-harness` provisions disposable PostgreSQL through Docker. When Docker is unavailable, `HARNESS_DATABASE_URL` may point it at an explicitly disposable external database; the harness truncates every Refuel402 table it owns, so never use production or shared state. Release acceptance runs the exact product harness twice. Deployed on-chain evidence and the newer locally verified contract source remain explicitly separate.

## Documentation and evidence authority

Maintained reader-facing documents are [`docs/PRODUCT.md`](docs/PRODUCT.md), [`docs/PRODUCTION.md`](docs/PRODUCTION.md), [`docs/SECURITY.md`](docs/SECURITY.md), [`docs/BRIDGES.md`](docs/BRIDGES.md), [`docs/DEMO.md`](docs/DEMO.md), and [`SUBMISSION.md`](SUBMISSION.md).

Current contract addresses and immutable deployment facts come from `contracts/deployments.json`; runtime support comes from live options/readiness/quote probes. Generated `proofs/local/*` files are reproducible test output and are not source authority.

## Repository map

```text
web/                         unified MetaMask product and diagnostics
server/src/support.ts        support-intersection authority
server/src/bridge.ts         provider adapters and normalized quote boundary
server/src/amount-domain.ts  decimal-safe source/destination/HBAR equation authority
server/src/combined-quote.ts bridge + Saucer + x402 + outcome ledger
server/src/evm-facilitator.ts self-hostable exact EVM facilitator service
server/src/policy-rpc.ts     MetaMask-compatible bounded sponsorship boundary
server/src/product-quote.ts  actual quote HTTP wrapper and injected provider/Saucer boundary
server/src/product-lifecycle-store.ts PostgreSQL journey/payment/authorization/reconciliation authority
server/src/product-lifecycle.ts HTTP lifecycle and injected verifier/builder/reconciler boundary
server/src/product-intents.ts server-authoritative destination transaction construction
contracts/                  exact proxy source, compiled artifact, and deployment configuration
server/src/planner.ts        reusable destination planning (legacy API included)
server/src/policy.ts         calldata/value/route policy
server/src/hedera.ts         HAPI sponsorship primitive behind policy RPC
server/src/postgres-store.ts durable lifecycle, replay, exposure authority
config/support.*.json        evidence-backed product candidates
config/whitelist.*.json      Saucer liquidity snapshots
docs/PRODUCT.md              authoritative product contract
```

## Security

Start with [`docs/SECURITY.md`](docs/SECURITY.md). Never commit `.env`, private keys, provider credentials, raw payment headers, raw signed transactions, or mutable lifecycle data.

License: MIT.
