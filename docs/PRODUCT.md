# Refuel402 product contract

This document is the authority for the user journey, support rules, quote model, wallet identity, and product acceptance. Security details live in [SECURITY.md](SECURITY.md); provider evidence lives in [BRIDGES.md](BRIDGES.md); deployment mechanics live in [PRODUCTION.md](PRODUCTION.md).

## Product promise

A user connects one stock MetaMask account and chooses one explicit route mode:

- `bridge_only` — deliver the selected asset to the same EVM address on Hedera. Provider quoting/execution remains independent of SaucerSwap availability. The quote makes no HBAR claim.
- `bridge_plus_refuel` — bridge the selected asset, then pay a bounded x402 fee and convert a bounded portion through a disclosed single-venue Saucer V1 or V2 exact-output route into native HBAR.

The user never imports a key, never connects HashPack, and never supplies a second destination address. `Auto` may compare providers for the same selected economic asset; it must not silently substitute another asset.

## User story

> As an EVM user bridging to Hedera, I choose bridge-only or bridge+refuel; select a provider policy, origin network, and token; enter the source amount and, when refueling, desired HBAR; review the mode-specific output, route, slippage, and fees; and approve one coherent asynchronous journey using the same MetaMask address throughout.

## Interface contract

Refuel402 has one transaction card with two explicit route modes, not separate applications.

The card contains:

1. **Network mode** — Testnet or Mainnet.
2. **Route mode** — `Bridge only` or `Bridge + refuel`. Bridge-only remains quoteable/executable when the provider route is ready even if Saucer routing or liquidity is unavailable. It renders one source → one full-width destination output and removes the HBAR card, fork branch, target/Max/slippage controls, refuel economics, and refuel copy.
3. **Bridge provider** — first-class selector with `Auto`, `Axelar / Squid`, and `LayerZero / Stargate`. The provider choice determines which origin networks are shown. Every choice remains inspectable when unavailable and exposes exact blockers. Explicit choices never fall back; `Auto` ranks only eligible provider quotes inside the token’s declared comparison group. No shipped catalog currently declares a multi-provider comparison group, so `Auto` today always collapses to a single candidate; the ranking machinery activates once a comparison pair lands.
4. **Origin network** — searchable dropdown restricted to the selected provider’s evidenced network scope, with network icon, chain label, connected-chain state, and disabled reasons.
5. **Origin token** — searchable dropdown filtered by both selected provider policy and origin network, with token icon, wallet balance, exact destination representation, support status, and disabled reasons.
6. **Origin amount** — editable, denominated in the origin asset, with wallet-balance affordance.
7. **Exact desired HBAR and verified outputs** — shown only for `bridge_plus_refuel`. Any positive tinybar-representable amount up to the configured/route-affordability boundary is user-selectable; 10 HBAR has no special minimum meaning. The server binds the exact desired output into quote identity and expiry. An ordinary feasible quote validates that exact output without running the expensive maximum solver; explicit **Max** and infeasible requests run the bounded conservative solver and return its limiting constraint/resolution. The client does not perform hidden fee arithmetic.
8. **Route and slippage consent** — every executable refuel quote names every hop, venue/version, pool/contract, fee tier, liquidity evidence, price impact, exact-output amount, retained amount, expiry, and maximum slippage. Setting the slippage tolerance and clicking the normal primary action is consent to that exact displayed quote; there is no separate checkbox boolean.
9. **Backend transparency** — one optional **Route details** disclosure contains provider/network scope, Saucer evidence where applicable, x402 authorization, gas sponsorship, operator-safe quote-stage timing, journey reference, recovery decision, and exact blockers.
10. **Mode-specific quote** — bridge-only defaults to bridge provider, estimated provider/relayer fee, ETA, and minimum received. Refuel defaults to bridge fee, user-borne refuel cost, total estimated fees without cross-currency summing, maximum slippage, and retained asset. Technical route/gas/pool/sponsor evidence stays in the single optional disclosure. Estimate, minimum, and reconciled-final values are labeled separately.
11. **One action** — starts or resumes the state machine. Internally the journey may require multiple wallet confirmations and an asynchronous bridge wait; progression remains inline in this card.

Changing the connected account, mode, selected chain, provider policy, selected token, or source amount invalidates the quote and any unsigned intents.

## Wallet and account identity

The core connector is the injected MetaMask EIP-1193 provider.

The invariant is:

```text
connected MetaMask account
  == bridge fromAddress
  == bridge toAddress
  == Hedera EVM alias
  == x402 payer                    (bridge_plus_refuel only)
  == destination approval/wrap/swap sender (bridge_plus_refuel only)
  == HBAR recipient                (bridge_plus_refuel only)
```

Addresses are compared as normalized 20-byte EVM addresses. No native Hedera account ID is requested from the wallet.

The browser may call:

- `eth_requestAccounts`
- `eth_accounts`
- `eth_chainId`
- `eth_call` (ERC-20 `balanceOf` / `allowance` reads only)
- `eth_getBalance`
- `eth_getTransactionReceipt`
- `wallet_switchEthereumChain`
- `wallet_addEthereumChain`
- `wallet_revokePermissions` (Disconnect only)
- `eth_sendTransaction`
- `eth_signTypedData_v4`

The browser must not call `eth_signTransaction`, native Hedera transaction-signing methods, or any private-key API.

WalletConnect may be added later only as another way to reach the same MetaMask EOA. It must not create a second-wallet or dual-namespace requirement.

## Unified state machine

| State | Meaning | Next safe action |
|---|---|---|
| `idle` | No valid connected account or selection | Connect/select |
| `discovering` | Provider, representation, Saucer, x402, and policy evidence is loading | Wait or change selection |
| `unsupported` | At least one support predicate failed | Show exact failed predicates; do not quote or execute |
| `quoting` | Server is composing a fresh combined quote | Wait; stale quote cannot execute |
| `ready` | Quote and same-address invariant are valid | Start journey |
| `activating_destination` | A provider-specific pre-arrival account/association step is required | Send only the quoted activation intent through the policy RPC |
| `submitting_bridge` | MetaMask is approving/submitting the origin provider transaction | Submit from the connected account to the same destination address |
| `bridge_pending` | Provider route is asynchronous | Poll provider status and Hedera arrival; never resubmit blindly |
| `arrival_confirmed` | Exact destination representation and balance are authoritative | Requote destination legs |
| `approving_payment_asset` | Permit2 allowance is insufficient | Send exact approval through policy RPC |
| `authorizing_x402` | MetaMask signs an EIP-712 Permit2 payment | Submit `PAYMENT-SIGNATURE` |
| `settling_x402` | Facilitator verifies and settles the fee | Wait for authoritative settlement response |
| `executing_refuel` | Paid quote unlocks exact wrap/approval/swap intents | Submit in nonce order through policy RPC |
| `reconciling` | Backend checks transactions, balances, HBAR output, and sponsor exposure | Wait; no duplicate side effect |
| `completed` | Required output and receipt predicates passed | Show one receipt |
| `failed` | A terminal provider, payment, or execution result exists | Show consumed/refundable amounts and retry boundary |
| `expired` | Quote/authorization expired before use | Requote |

The browser is a statically bundled Preact application. One `@preact/signals` store owns state transitions and calls the existing wallet/API/orchestrator/persistence modules; pure compose, journey, Activity, and shell view models derive presentation; components only render signals and dispatch explicit actions. The Preact conversion changes presentation architecture, not lifecycle authority or wallet boundaries.

The browser persists only a versioned owner-scoped active pointer: journey ID, account, mode, route mode, and pointer timestamp. It never stores form values, quote economics, wallet boundaries, events, payment/submission data, recovery decisions, or Activity rows. Legacy rich local records are removed and never auto-activated. The app never writes a journey ID into the address bar. An explicit `?journey=<id>` link is still honoured when someone opens one, and the active pointer resumes a journey by itself **only** when the server reports funds already in flight (`poll_bridge` with `replaySafe`). A bounded server sweeper now polls already-durable `bridge_pending` journeys with PostgreSQL advisory-lock ownership, exponential backoff, and idempotent reuse of the same arrival materializer, so arrival no longer depends on an open browser. Any other stored journey is offered above an untouched draft and can be dismissed; without one, the primary screen is a clean draft. `GET /v1/product/journeys/:id` is a pure read of the authoritative quote, events, submissions, and recovery decision, while bounded `GET /v1/product/journeys?account=&limit=&before=&beforeJourneyId=&beforeActive=` serves the secondary account-scoped Activity drawer without changing the form. Its cursor contains the active-work category, update timestamp, and journey-ID tie-breaker; active/in-flight work is ordered ahead of ready drafts without page-local re-sorting or timestamp-tie loss. Once arrival is durable, only an explicit primary action calls `POST /v1/product/journeys/:id/destination-quote`; reads and timers never mint a quote. If a sponsored leg has 30 seconds or less of quote runway, authorization returns `409 QUOTE_EXPIRES_TOO_SOON`; the browser refreshes only the destination quote and retries that server authorization without prompting the wallet or repeating a settled payment. A post-payment quote may keep or improve the consented exact HBAR, maximum destination debit, and minimum retained asset; `409 QUOTE_ECONOMICS_WORSENED` writes nothing and presents the comparison for an explicit owner decision. Replay-safe bridge status remains bounded; a 15–20+ minute bridge is not abandoned after a short browser timeout.

Before any source-wallet boundary exists, a journey with no bridge hash, payment, or unresolved submission may bind one fresh executable source quote and expose **Send this journey again**. Binding requires the owner's EIP-712 `SourceLegConsent` over `{journeyId, quoteId, account, mode}` on the journey's origin chain, naming the replacement quote so it cannot be replayed onto a later re-bind. The server preserves the journey ID, expires only unbroadcast activation reservations, reuses completed destination activation, and still writes the wallet boundary before requesting the origin-chain send. A source-wallet boundary without a persisted transaction hash hard-stops that journey's continuation. If the wallet did broadcast, the user may paste the exact source hash and sign an EIP-712 `BridgeAdoption` consent bound to `{journeyId, account, sourceTransactionHash, mode}`; `POST …/bridge/adopt` accepts it only when the signature recovers to the journey owner, the provider recognizes the hash, and authoritative Hedera history identifies exactly one unbound matching destination credit. Unknown sponsored submissions use `POST …/reconcile-submissions`, which reads mirror evidence only and distinguishes mined success, mined revert, provably never broadcast, and ambiguity; it never signs or resubmits. Selected-journey controls are locked against draft edits. **Start new transfer** clears only the local selected pointer and strips a `?journey=` link if one was opened, without a reload and without deleting, replaying, canceling, or repairing the immutable server journey. Activity remains available for explicit later selection, and another account never inherits that pointer or Activity response.

## Destination activation and hollow accounts

A bridge/provider may or may not deliver to an uncreated Hedera EVM alias. Support data must explicitly classify each asset:

- `arrival_auto_create_proven` — direct arrival to an uncreated alias is live-proven.
- `activation_required` — before bridge submission, the backend creates a hollow account with a bounded HBAR transfer and MetaMask submits an exact sponsored completion/association transaction.
- `arrival_unproven` — execution disabled.

The first sponsored Ethereum transaction from a hollow alias completes the account using MetaMask’s ECDSA signature. Activation is an inline journey state, not another wallet or setup product.

## Support intersection

Every route mode first requires:

1. **Provider route** — the provider currently quotes the selected origin chain/token to Hedera and returns an executable transaction.
2. **Same-address delivery** — the provider accepts the connected EVM address as destination and its activation class is proven.
3. **Destination representation** — exact address, standard (`HTS` or contract ERC20), decimals, token risks, and association behavior are known.
4. **Execution mode** — the selected network/provider execution gate is enabled.

`bridge_only` stops at those predicates. Saucer, Permit2, x402, wrapper, facilitator, and Router availability cannot disable an otherwise executable provider bridge.

`bridge_plus_refuel` additionally requires:

5. **Saucer route** — a live single-venue V1 or V2 exact-output route to WHBAR/HBAR passes path, liquidity floor, price-impact, slippage, and amount policy. Mixed-venue paths remain unsupported. The `MIN_SAUCER_ROUTE_LIQUIDITY_USD` floor (default $100, a dead-pool filter sized against the 50 HBAR `MAX_REFUEL_TINYBAR` cap; below ~$450 of pool TVL `MAX_PRICE_IMPACT_BPS` is the binding gate — see `docs/BRIDGES.md`) and the fair-value deviation gate (`MAX_QUOTE_FAIR_VALUE_DEVIATION_BPS`, quote-implied HBAR price of the input token vs SaucerSwap `priceUsd` and the network HBAR/USD rate) are refuel execution gates at quote time: a failed check on the *selected* route returns the quote with the stable blocker (`SAUCER_LIQUIDITY_POLICY`, `SAUCER_FAIR_VALUE_DEVIATION`) and `capabilities.execute: false`; when hydration finds no eligible path at all the asset is not quote-ready and `/v1/product/quote` answers `409 PRODUCT_QUOTE_NOT_READY` with the same blocker. Unpriceable evidence is disclosed as `fair_value_unverified` rather than fabricated.
6. **x402 compatibility** — the arrived payment asset can use standard EVM exact through the deployed Permit2/proxy and ready facilitator.
7. **Sponsorship** — every required activation, approval, wrapper, and Router target is authorized by the policy RPC.
8. **Policy** — retained value, sponsor balance, reserve floor, per-request exposure, rolling daily exposure, active concurrent reservations, gas allowances, deadline, and account state pass.

Discovery support is not execution support. The UI shows candidates that fail the intersection as disabled with stable, specific reasons.

The catalog in `config/support.<network>.json` is evidence and bootstrap data. Runtime provider and Saucer readback decide whether a candidate is currently executable.

## Network modes

### Testnet

Hedera testnet has Axelar ITS and LayerZero endpoints. The currently evidenced cross-chain token set does not intersect a relevant SaucerSwap testnet route:

- Axelar AXE exists but has no AXE/WHBAR, AXE/USDC, or AXE/SAUCE V2 pool.
- LayerZero/Stargate exposes no Hedera testnet asset in current metadata.

Testnet therefore shows the real candidates and reasons, but the full bridge+refuel action is disabled until the intersection changes. It may prove the unified UI, same-address invariant, provider discovery, post-arrival Saucer quoting with native test assets, policy RPC, EVM x402, and sponsor mechanics independently.

### Mainnet

Mainnet source includes evidence-backed candidates such as:

- Axelar USDC on HTS, routed through native USDC to WHBAR.
- LayerZero WBTC contract token, wrapped to HTS WBTC, then routed through native USDC to WHBAR.
- LayerZero USDT0 on HTS uses the verified Ethereum USDT adapter ↔ Hedera OFT peer and routes through native USDC to WHBAR. Administrator/freeze-key metadata remains truthful internal evidence but is not a consumer warning badge or execution blocker.
- Stargate V2 exposes Ethereum native ETH → Hedera WETH (`0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2`) through its permissionless native Pool → Hedera OFT taxi path. Refuel verifies the current source pool, destination OFT/token, EIDs, shared decimals, path credit, TokenMessaging contracts/peers and bytecode, then builds `quoteOFT`/`quoteSend`/`send` directly with principal-plus-fee native value and no ERC20 approval. This makes `bridge_only` executable without `LAYERZERO_TRANSFER_API_KEY`. `bridge_plus_refuel` remains independently gated by the fresh hydrated Saucer graph and venue-specific exact-output liquidity-floor, price-impact, slippage, affordability, and retained-asset checks; fresh below-floor liquidity gates refuel execution with `SAUCER_LIQUIDITY_POLICY` while `bridge_only` stays unaffected. The credentialed Value Transfer API is fallback-only and the retired WETH→WETH direct-OFT assumption is forbidden.

Mainnet discovery, representation, wrapper, and pool contracts are source-supported. Fresh proof establishes direct Ethereum-WBTC → Hedera-WBTC and Ethereum-USDT → Hedera-USDT0 OFT peers/quote/send/status, plus venue-specific V2 and V1 Saucer exact-output reads. The 2026-07-26 LCX.axl proof selected V1 pool `2772` / `0.0.10493784` and quoted exactly 10 HBAR without a wallet transaction. The deployed generation later completed wallet-authorized terminal journeys, including WBTC → 25 HBAR; the newer donation-resistant local contract source is not deployed and does not inherit that generation's live acceptance.

## Combined quote

The browser requests one server-composed quote. It must include:

### Identity and freshness

- immutable quote/journey ID
- mode and all chain IDs
- requested provider policy, selected provider, eligible providers actually compared, and comparison group
- normalized connected account and same-address proof
- provider quote ID and expiry
- destination quote timestamp and expiry
- policy version and support-evidence timestamps

### Bridge leg

- provider and route type
- source token/address/decimals and amount
- destination token/address/standard/decimals
- expected and minimum destination amount
- provider, bridge, gas, and integrator fees with payer/asset
- estimated duration/range
- approval and transaction targets
- activation requirement

### Destination leg

- explicit user-selected desired HBAR, normalized to tinybar and bound into quote identity/expiry
- server-verified conservative maximum feasible HBAR, limiting constraint, headroom, candidate budget, and remaining solver resolution
- wrapper leg and conversion rate when the arrival asset is contract ERC20
- ordered Saucer hop evidence: token ids/addresses/symbols, pool/contract ids, venue/version, V2 fee tier, per-hop liquidity, wrapper and WHBAR boundaries
- V1/V2 discovery counts plus the honest execution scope (`venue_aware_exact_output`; mixed-venue paths remain unsupported)
- Saucer exact-output amount, maximum input, gas estimate, slippage and measured/estimated price impact
- token-risk and liquidity-policy results

### x402 and sponsor leg

- x402 network, scheme, transfer method, fee asset, amount, payee, and timeout
- Permit2 allowance/approval requirement
- per-intent sponsor caps and total exposure
- expected HAPI/gas cost, failure reserve, and operating margin

### Outcome

- total maximum debit of the destination asset
- minimum retained destination asset
- exact expected HBAR output
- all blockers/warnings
- execution capability and remaining live gates

### Arithmetic

The canonical server equations are unit-scoped and decimal-safe:

```text
source input
  = effective provider deduction in source units
  + source-equivalent gross destination arrival

gross destination arrival
  = provider slippage buffer
  + x402/protocol fee in destination units
  + maximum destination-asset input consumed to buy HBAR
  + destination bridged asset remaining

exact HBAR output = receipt postcondition minimum = user-selected desired tinybar
(the minimum field is a verification guarantee, not a product minimum amount)
```

Source and destination denominations are compared only when the adapter proves equal-decimal source-equivalent bridge units. Provider itemization, unitemized difference, and overlapping fee evidence are exposed separately so the effective deduction is counted once. For an HTS arrival asset:

```text
maximum destination debit
  = maximum Saucer input
  + x402 fee in destination asset
```

For contract ERC20 arrivals:

```text
maximum raw-token debit
  = raw amount converted for maximum HTS swap input
  + x402 fee in raw token
  + wrapper rounding reserve
```

Retained balance uses maximum debit, never the optimistic expected debit.

## Typed cost and payer ledger

Every row records stage, payer, one funding source (`user_origin`, `deducted_from_bridge`, `sponsor`, or `included_in_swap`), asset/currency, native/base units, exact/estimated/maximum status, and optional timestamped fiat evidence. Native gas, token deductions, and sponsor HBAR are never added into one unlabeled total. Fiat total remains absent unless every component shares one complete timestamped price set.

| Cost | Payer | Asset |
|---|---|---|
| Origin ERC20 approval | User | Origin native gas |
| Bridge/provider transaction | User | Origin native gas and/or source token |
| Cross-chain delivery/gas | User, quoted by provider | Provider-defined |
| Optional destination activation | Refuel sponsor, tightly capped | HBAR |
| Permit2 approval | Refuel sponsor via policy RPC | HBAR |
| x402 settlement transaction | x402 facilitator | HBAR |
| x402 service fee | User | Destination payment asset |
| Wrapper/Router execution | Refuel sponsor via policy RPC | HBAR |
| Swap input | User | Destination asset/HTS wrapper |
| HBAR output | User receives | HBAR |
| Refund after pre-attempt failure | Refuel fee collector/sponsor | Collected x402 asset, per policy |

Wrapper conversion, price impact, slippage headroom, LP fee tiers, and provider fee components may be disclosed as included evidence without becoming a second debit. Summary groups remain currency-specific: user-origin, deducted-from-bridge, policy-RPC sponsor-covered, facilitator-covered, retained bridged asset, and exact HBAR received. The x402 facilitator settlement exposure is priced and shown separately from policy-RPC sponsor exposure. Each destination intent consumes the matching quote-bound execution-leg gas allowance; it never inherits the global per-transaction cap. Every receipt reports actual payer and consumed/refunded amounts by leg.

## Frontend APIs

The target frontend surface uses only public, redacted endpoints:

- `GET /v1/product/options?mode=<mode>` — normalized networks, providers, tokens, and independent support states for `bridge_only` and `bridge_plus_refuel`.
- `POST /v1/product/quote` — mode-specific quote. `routeMode=bridge_only` returns provider arrival/retention with no HBAR claim; `routeMode=bridge_plus_refuel` requires decimal `desiredHbar` and returns HTTP 422 with maximum/constraint evidence when unaffordable.
- `GET /v1/product/quotes/:id` — persisted immutable quote/provider/support identity.
- `POST /v1/product/journeys` — persist/start a quoted journey; no chain mutation by itself.
- `GET /v1/product/journeys/:id` — pure read of the authoritative quote, journey, payment, authorization, submission, immutable events, and machine-readable recovery decision; it performs no quote minting, signing, submission, or replay.
- `GET /v1/product/journeys?account=&limit=&before=&beforeJourneyId=&beforeActive=` — read-only Activity page with a deterministic composite cursor and active-work priority.
- `GET /v1/product/journeys/:id/events` — ordered append-only lifecycle events.
- `GET /v1/product/journeys/:id/submissions` — durable submission attempts and terminal/unknown outcomes.
- `POST /v1/product/journeys/:id/activate` — idempotently creates the hollow destination alias with a capped sponsor transfer when required; the browser then completes association through an exact policy-RPC authorization.
- `POST /v1/product/journeys/:id/wallet-boundary` — append-only marker written immediately before origin approval or bridge consent. If refresh occurs before an authoritative source hash is stored, recovery hard-stops rather than guessing or replaying.
- `POST /v1/product/journeys/:id/bridge` — persists the single origin transaction identity and pre-bridge destination balance.
- `GET /v1/product/journeys/:id/bridge` — reads provider status, destination transaction, and exact balance delta; unknown results stop rather than resubmit.
- `POST /v1/product/journeys/:id/bridge/adopt` — binds a lost source hash only after EIP-712 owner consent, provider confirmation, and exactly one unbound matching Hedera credit; missing, conflicting, deep, or ambiguous evidence makes no write.
**Source-leg ownership.** Per-journey reads are not account-scoped, so a journey id is not a secret. Every mutation on the source leg — `POST …/activate`, `…/wallet-boundary`, `…/bridge`, `…/intents/activation/authorize` and `…/source-quote` — therefore requires the owner's EIP-712 `SourceLegConsent` over `{journeyId, quoteId, account, mode}`, recovered against the journey account and re-asserted inside each mutating transaction against the row it locks. One consent covers the whole leg: these calls are the mechanics of one owner decision, so they cost one prompt, taken on the origin chain the leg must reach anyway. `POST …/reconcile-submissions` is deliberately left open — it is the escape hatch blocked journeys are pointed at, and every write it makes derives from mirror evidence rather than the request body. `…/reconcile`, `…/intents/:kind/confirm` and `…/payment` are already bound to the journey account by chain receipt or x402 payer identity.

- `POST /v1/product/journeys/:id/source-quote` — binds one live executable source re-quote to the same journey only while the pre-wallet-boundary/no-bridge-evidence predicate remains true, and only with an EIP-712 `SourceLegConsent` recovering to the journey owner for that exact replacement quote.
- `POST /v1/product/journeys/:id/destination-quote` — explicitly refreshes Saucer/x402/sponsor terms after authoritative arrival.
- `POST /v1/product/journeys/:id/reconcile-submissions` — releases review state only from mirror-proven success, revert, or never-broadcast evidence; ambiguous and conflicting evidence remain blocked.
- `POST /v1/product/journeys/:id/payment` — first returns the quote-bound custom Refuel402 Permit2 witness challenge, then verifies/settles one x402 payment.
- `POST /v1/product/journeys/:id/intents/:kind/authorize` — returns one server-built activation, Permit2 approval, wrapper approval, wrapper execution, Router approval, or exact-output Router transaction. The unsigned fields are persisted; the policy RPC later recovers the actual raw signer and atomically consumes the one exact matching authorization.
- `POST /v1/product/journeys/:id/intents/:kind/confirm` — binds non-terminal destination intents to authoritative receipts before state progression.
- `POST /v1/product/journeys/:id/reconcile` — binds the submitted Router hash to an authoritative receipt/balance readback and completes the journey once.
- `POST /rpc/<mode>` — policy RPC. Read methods proxy upstream; raw submission is accepted only when it matches an unexpired server authorization.

At `integration_harness`, PostgreSQL persists immutable provider-bound quotes, journeys, pre-wallet boundaries, activation/bridge/arrival evidence, bridge-only terminalization, refreshed destination quotes, payments, one-time authorizations, durable submission attempts, refresh/restart recovery state, mirror-evidence submission reconciliation, owner-consented bridge adoption, final reconciliation, and append-only lifecycle events. The exact `npm run e2e:product-harness` wrapper uses the UI request model, extracted product quote handler, real lifecycle HTTP router, PostgreSQL 18, custom Refuel402 Permit2-witness verification, local facilitator/proxy simulation, bounded submitter, policy RPC, intent confirmation, and receipt reconciliation for chain IDs 296 and 295. Docker provisions the disposable database by default; readiness requires a successful host TCP connection, not only container-local `pg_isready`. `HARNESS_DATABASE_URL` supports an externally provisioned disposable database and truncates all harness-owned tables before each run, so it must never target production or shared state. The harness is run twice back-to-back to prove reset/idempotency behavior. Its P0 path proves 3 USDC → explicit persistent destination consent → exactly one payment and sponsored router execution → terminal +10 HBAR with retained USDC above the disclosed minimum; additional scenarios prove human-paced quote expiry, no duplicate payment/leg, and fail-closed worsened re-quotes. `npm run e2e:browser-harness` separately proves that no journey ID is ever written to the URL, that web storage is owned by exactly one module, that automatic resume is limited to a bridge with funds in flight, minimal pointer reload, legacy-rich-state retirement, clean local detachment, server-bounded account Activity, authoritative event-derived progress, pure journey reads, one-shot wallet/provider boundaries, typed malformed provider errors, checkbox absence, native ETH semantics, server-solved Max HBAR, and bounded WBTC recovery. Production injection remains fail-closed behind explicit runtime flags, deployed bytecode, funded roles, and live receipt gates.

Legacy technical endpoints may remain for CLI/agent compatibility only if clearly isolated and cannot be mistaken for the product flow.

## Backend boundaries

### Provider adapters

Provider credentials and Saucer developer API keys are server-only. Adapters normalize discovery, quote, transaction, status, fees, ETA, and redacted error classes. A missing credential returns a disabled capability; it never causes static fallback data to become executable.

### Support authority

The support service joins provider route data, destination representations, wrapper data, Saucer route evidence, x402 contract/facilitator state, sponsorship target policy, and product limits.

### Policy RPC

The RPC submission record is immutable and binds:

- journey/quote/payment IDs
- account, chain, nonce, target, calldata hash, value
- gas and sponsor cap
- activation/payment/execution phase
- expiry and one-time-use status

A raw transaction not matching the record is rejected before sponsor submission. Consumption is atomic and one-time. A submission error is recorded as unknown and is never retried blindly. Restart or scoped recovery waits through the in-flight grace window, promotes only expired consumed-without-result records to review, and `reconcile-submissions` releases them only from authoritative mirror evidence; an unavailable or contradictory result remains blocked.

### x402

Core payment uses `exact` on `eip155:<Hedera chain id>` with `assetTransferMethod=permit2`. MetaMask signs the Permit2 EIP-712 domain. `Refuel402ExactPermit2Proxy` binds payer, token, amount, recipient, chain, nonce, deadline, proxy spender, and quote context hash; enforces facilitator-only settlement, one-time replay protection, and reentrancy control; then emits the settlement proof event. The self-hosted facilitator exposes `/live`, `/health`, `/supported`, `/verify`, and `/settle`, applies chain/rate/idempotency policy, redacts secrets, and waits for the proxy receipt before returning settlement success. Testnet and mainnet Permit2/proxy deployments are live-verified, and the mainnet wallet, facilitator, policy-RPC, sponsored-intent and terminal reconciliation gates have all passed on completed journeys.

## Implementation-completion matrix

This matrix separates the current local source from the deployed generation. “Complete at `integration_harness`” means the real browser/API entrypoint passes through disposable PostgreSQL plus faithful provider, facilitator, sponsor, and EVM boundaries. Only authoritative same-release chain/provider receipts establish `live_proof`.

| Surface | Completion contract | Current state | Does it make bridging functional? |
|---|---|---|---|
| Product research/spec/documentation | One authority, explicit provider semantics, same-wallet invariants, aligned reader-facing docs | Complete at `integration_harness` after release checks | No |
| Railway/PostgreSQL/Cloudflare infrastructure | Same commit read back from both deployments; healthy persistence, contracts, provider, facilitator, policy RPC, and browser/API wiring | Deployed generation accepted; current local source not deployed | Only for the accepted deployed generation |
| Unified one-wallet browser entrypoint | Quote, consent, bridge, arrival, payment/refuel, sponsored intents, and terminal reconciliation | Integration harness passes; deployed generation also has terminal mainnet receipts | Structurally yes; live for the deployed generation |
| Durable journey/payment/authorization persistence | Provider-bound quote/journey, one payment identity, one-time authorization, durable submissions, append-only events, unknown-result recovery | Integration harness passes; deployed journeys reconciled terminally | Yes when paired with same-release runtime evidence |
| Provider quote and chain execution | Origin bridge, destination arrival, Permit2/proxy settlement, sponsored exact-output conversion, HBAR receipt | Three deployed-generation mainnet journeys completed, including WBTC → 25 HBAR | **Yes for the deployed generation** |

Do not transfer deployed-generation `live_proof` to a newer local source automatically. The donation-resistant source remains at local/integration acceptance until it is deployed, authoritatively read back, and exercised by a terminal same-release journey.

## 50-HBAR source capability and live gate

The source quote/planner model supports a configured maximum of `5,000,000,000` tinybar (50 HBAR). This is capability, not live activation. Every candidate remains bounded by live route simulation, maximum slippage and price impact, minimum retained asset, sponsor balance, reserve floor, per-request exposure, per-leg gas/HAPI allowances, rolling daily exposure, and active concurrent maximum-exposure reservations. The same checks are repeated atomically before sponsored submission.

Production activation remains separate from source support. A live cap/risk change requires a reviewed plan with current sponsor/liquidity evidence, bounded blast radius, rollback, evidence/log location, and staged post-activation proof. The 2026-07-26 serious-testing envelope uses 10→25→50 HBAR stages and the bounded sponsor controls documented in `PRODUCTION.md`.

## Safety and acceptance

Required source/integration checks:

- same-address invariant and account/chain drift rejection
- support intersection and disabled-reason stability
- quote arithmetic and fee/payer ledger
- provider/API credential redaction
- Permit2 typed-data path; no raw-signing request
- activation, payment, and execution phase authorization
- testnet/mainnet fail-closed gates
- value, slippage, impact, retained-balance, request, reserve, and daily caps
- idempotent resume and no duplicate submission
- full test/typecheck/build/static QA and secret scan

Acceptance levels:

- `policy_only` — architecture/spec only.
- `integration_harness` — adapters, state machine, APIs, UI, and deterministic tests/build pass; no live chain claim.
- `live_proof` — same MetaMask address completes the exact provider route, destination activation/arrival, Permit2/x402 settlement, sponsored conversion, HBAR receipt, and reconciliation with authoritative links/records.

The current donation-resistant local source must not claim above `integration_harness` until separately deployed and proven; the immutable deployed generation retains its own `live_proof` receipts.

## Pre-authorized one-signature continuation

`ONE_SIGNATURE_REFUEL.md` defines the capped Hedera-domain Permit2 witness, two-hour deadline, price-protection presets, server-owned post-arrival continuation, bounded retry/fallback behavior, and the standing Permit2 allowance prerequisite. The feature requires `REFUEL_PREAUTHORIZATION_ENABLED=1` and is enabled in the live deployment, where it has completed mainnet refuels. Manual `destination_wallet_consent` remains the safe authority whenever one-signature eligibility is absent, and every fallback targets it.

## Explicit non-goals

- HashPack or a second wallet in the core flow.
- Key import, custody, export, or recovery.
- Smart-account address substitution.
- A second Bridge or Refuel application/tab.
- Blind support based on symbol/name matching.
- Browser exposure of Saucer/provider private API keys.
- Reuse of SaucerSwap corporate project IDs or credentials.
- Live mainnet transactions, contract deployment, provider mutation, or funds movement without later exact approval.
- QuickNode, Reown, or another paid service unless a proven acceptance blocker cannot be solved safely with current resources.
