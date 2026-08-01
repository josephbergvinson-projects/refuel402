# Production and live-proof runbook

The product contract is [`PRODUCT.md`](PRODUCT.md). This runbook does not authorize external mutation.

## Current deployment posture

The deployed mainnet generation has `live_proof` from wallet-authorized terminal journeys. The newer donation-resistant source in this repository remains at local/integration acceptance until that exact standing commit is deployed and read back from Railway and Cloudflare Pages, Railway reports healthy PostgreSQL plus deployed Permit2/exact-proxy, facilitator, policy-RPC, provider, and Saucer readiness, and a new terminal journey reconciles. Wallet consent alone is not valid proof against a mixed or partially updated release.

Testnet and mainnet contract authority is `contracts/deployments.json`. Public deployment records distinguish immutable deployed bytecode from newer local source; neither component evidence nor a source build authorizes a wallet transaction.

Existing external resources only:

| Resource | Current state | Recommendation | Removal condition |
|---|---|---|---|
| Railway Node backend | Existing, healthy/readiness-accepted, mainnet executable at last public readback | **Keep**; update only this existing service from an accepted standing commit | Roll back to the captured prior deployment if same-release health/options/quote/readback fails |
| Railway PostgreSQL | Existing, healthy | **Keep** with backend; required for production lifecycle/authorization | Preserve lifecycle data; remove only after a separate retention/export decision |
| Cloudflare Pages | Existing one-wallet shell; release state must be proven by bundle/API-origin hash readback | **Keep**; update only the existing `refuel402` project after source acceptance | Roll back to the captured prior deployment if asset identity, CSP/CORS/API binding, recovery controls, or browser consent proof fails |
| Reown project | None | **Do not create** for the core product | Not applicable |
| QuickNode paymaster | None | **Do not create** unless self-hosted policy RPC cannot meet a proven acceptance predicate | Not applicable |
| Squid integrator | A configured server-side attribution identity and fresh wrapper quote produced an executable Ethereum USDC → Hedera mainnet USDC.axl route | Bind it server-side as `SQUID_INTEGRATOR_ID`; it is not a browser credential | Remove the binding when the provider integration is retired |
| Saucer public API | Canonical host key returned HTTP 200 with 1,529 token rows on a reconciled `/tokens` + `x-api-key` probe on 2026-07-22 | Inject it by secret alias as Refuel `SAUCERSWAP_API_KEY`; never copy it into source | Revoke/rotate in the host secret store and Railway |
| x402 EVM facilitator | Existing isolated Railway service; mainnet health/support accepted at last same-release readback | Keep the existing service and re-prove `/health` + `/supported`; create no replacement service | Remove only after payment obligations settle and receipts/keys are retained/revoked |
| On-chain Permit2/x402 contracts | Testnet and mainnet Permit2 + exact proxy deployed and verified | Preserve receipt/runtime/immutable proofs and require fresh same-release code/immutable readback | Immutable; disable product routes rather than attempting deletion |

No free-tier resource should be created speculatively. Existing resources should be kept only through a bounded test/decision window.

## Required server configuration

Use [`.env.example`](../.env.example) as the key-name reference. All provider/Saucer/sponsor/facilitator/PostgreSQL values are server-side.

Never put a secret in `VITE_*`.

Read-only startup is valid. Write capability is valid only when every evidence gate and matching runtime flag is true.

## Deployment topology

Preferred lowest-cost topology:

1. **Cloudflare Pages** — static unified UI.
2. **Existing Railway Node service** — product options/quote, provider adapters, policy RPC, x402 resource server, lifecycle API.
3. **Isolated Railway facilitator service** — minimal three-dependency image on `0.0.0.0:4402`; execution disabled until manifest acceptance.
4. **Existing Railway PostgreSQL** — provider-bound quote/journey/payment/authorization/submission/event/idempotency/recovery authority.
5. **Hedera JSON-RPC/mirror upstreams** — reads only; production Mirror REST capacity/credentials remain server-side.

Do not add Reown. Do not add QuickNode unless a source/runtime acceptance blocker demonstrates the existing-backend policy RPC is inadequate.

## Build and source gates

```bash
npm ci
npm test
npm run typecheck
npm run e2e:harness
npm run e2e:product-harness
npm run contracts:compile
npm run contracts:verify
VITE_API_BASE_URL=https://<accepted-api-host> \
  PAGES_BUILD_PROOF_PATH=<run-artifact>/pages-build-proof.json \
  npm run build:pages
```

`build:pages` is the only accepted production Pages package entrypoint. It fails closed when `VITE_API_BASE_URL` is absent or non-HTTPS, then verifies that the compiled entry bundle contains the exact API base and that `_headers` permits the same API origin in `connect-src`. `npm run build:web` remains a local source/build check and is not a production package proof.

`e2e:product-harness` creates a disposable PostgreSQL 18 container by default. If Docker is unavailable, `HARNESS_DATABASE_URL` may point the same wrapper at an explicitly disposable external database; the harness truncates all Refuel402 tables it owns before each run. `TEST_DATABASE_URL` is the equivalent destructive integration-test lane and must run the PostgreSQL files sequentially with `--no-file-parallelism`. Neither variable may ever target Railway, production, a shared developer database, or retained evidence. Run the external-database product harness twice back-to-back to prove cleanup and idempotency rather than accepting one green run.

Also require:

- secret scan;
- support-catalog JSON parse/schema checks;
- no browser bundle contains provider, Saucer, sponsor, facilitator, or database credentials;
- no product connector requests raw/native Hedera signing;
- generated `dist/` remains ignored/outside source commit;
- clean source checkout after build;
- destructive PostgreSQL tests run only against a disposable isolated instance, never the Railway database;
- exact provider selection/reset/keyboard/mobile source-contract tests pass.

## Provider gates

### Axelar / Squid

1. Obtain a separate Refuel402 integrator ID.
2. Configure the correct environment base URL.
3. Probe chains/tokens/routes server-side.
4. Verify response schema, target, calldata, value, fees, ETA, and exact destination representation.
5. Confirm `fromAddress === toAddress === connected MetaMask account`.
6. Prove status polling and destination arrival idempotency. For an HTS destination, a unique post-submission Mirror credit may establish chain-authoritative arrival while provider indexing still reports pending only when all of these match: journey recipient, expected HTS token, stored source transaction and provider route identity, exact expected or minimum quoted amount, consensus time after the stored submission, and baseline-to-current balance delta. Record the Hedera transaction ID/hash and `providerLagging`; continue provider polling for observability without holding the journey. Ambiguous, wrong-recipient, wrong-token, wrong-amount, pre-submission, or duplicate candidate credits remain pending.
7. Keep errors redacted and rate-limited.

### LayerZero / Stargate

1. Keep deployment/asset discovery separate from execution readiness.
2. For Ethereum WBTC → Hedera WBTC and Ethereum USDT → Hedera USDT0, use the credential-free direct OFT path: verify canonical source token, route-specific adapter, destination OFT/token and bidirectional peers; call `quoteOFT`/`quoteSend`; validate the exact approval and `send` target/data/value; and normalize status through public LayerZero Scan plus authoritative Hedera arrival balance delta.
3. Treat initial Scan indexing as pending, never as permission to resubmit; only delivered plus successful destination execution confirms arrival.
4. Validate wrapper counterpart/rate/key policy when a route uses a wrapper, HTS association, exact Router approval, and venue-specific exact-output execution in order.
5. Ethereum → Hedera WETH uses **native ETH** (`0xEeee…EEeE`) and the official Stargate V2 native Pool `0x77b2…7931` on Ethereum, with Stargate OFT `0xda60…dCAd` delivering WETH `0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2` on Hedera. Before each quote, verify code, source/destination EIDs and Stargate types, zero-address source token, destination WETH token, shared decimals, route credit, `getAddressConfig()` TokenMessaging contracts, and their bidirectional peers. Then call permissionless `quoteOFT`/`quoteSend`, require dust-free exact source amount, encode `send`, set transaction value to principal plus native messaging fee, require no ERC20 approval, and use public LayerZero Scan status. `LAYERZERO_TRANSFER_API_KEY` is fallback-only for routes without this adapter; absent authorization must be shown as `Provider API authorization required`, never generic bridge unavailability. Never substitute the old WETH→WETH direct-OFT assumption or provider-global WBTC/USDT0 readiness. USDT0 administrator/freeze-key metadata remains internal diagnostic evidence and does not badge or block the executable route.

## Destination-account gates

For each provider/asset:

1. Start from a documented nonexistent or hollow same-address account.
2. Determine whether provider arrival can create/associate it.
3. If not, prove the bounded activation sequence:
   - sponsor creates hollow account;
   - MetaMask submits a sponsored completion/association transaction;
   - mirror readback shows completed ECDSA account and correct association.
4. Record the result as `arrival_auto_create_proven`, `activation_required`, or `arrival_unproven`.
5. Do not reuse one asset’s result for another bridge/token implementation.

## x402 deployment gates

Read-only evidence at reset time:

| Network | Permit2 | x402 exact proxy |
|---|---|---|
| Hedera testnet | Present at canonical address | Current-source proxy deployed and runtime-verified at `0xDC1E48E6b365487514447A66dA20E8b8B58a26C3`. No testnet asset intersects a qualifying Saucer route, so the journey is not exercisable there |
| Hedera mainnet | Deployed and verified at `0x71304d9943C9d46A18cB6238759800320540F0e4` | Current-source proxy at `0x91d81fbAf684482a9db0195C0d8d5bDc4880b2b4`, live, with completed pre-authorized refuels |

Source includes `contracts/Refuel402ExactPermit2Proxy.sol`, the pinned compile wrappers, named immutable references, tracked ABI/bytecode artifacts, deterministic CREATE2 helpers, and the isolated facilitator image. `contracts/deployments.json` binds both networks' factories, salts, init-code/runtime hashes, facilitator immutables, and successful transaction receipts.

Any live deployment requires a fresh reviewed manifest stating exact bytecode/commit, deterministic deployer, facilitator, sponsor, expected addresses, payer, HBAR exposure, verification commands, evidence location, rollback/stop condition, and exclusions.

Then:

1. configure the existing isolated facilitator service for the selected deployed network/contracts;
2. bind the existing backend to the selected facilitator/sponsor roles and policy RPC;
3. verify the custom Refuel402 Permit2-witness challenge rather than upstream hard-coded x402 contract constants;
4. prove Permit2 approval through stock MetaMask/policy RPC;
5. record payer, asset, amount, tx hash, receipt, replay rejection, bridge arrival, sponsor exposure, and terminal reconciliation.

A public facilitator may replace self-hosting only after its Hedera EVM network, assets, limits, support, cost, and custody model are verified.

### Facilitator key rotation

The proxy's facilitator address is a constructor immutable; there is no rotation or pause mechanism. Compromise or loss of the facilitator key requires deploying a new proxy at a new CREATE2 salt and updating the backend support addresses. The only immediate mitigation is disabling the route/facilitator in backend configuration.

## Policy-RPC write gates

The source processor proxies approved read methods and has the PostgreSQL/SponsorClient write integration boundary. It still fails writes closed unless both policy-RPC readiness flags, PostgreSQL, and sponsor credentials are present.

Implemented and integration-tested:

1. PostgreSQL provider-bound quote, journey, payment, authorization, durable submission, final reconciliation, and append-only event rows with immutable identity fields;
2. exact HTTP readback for quotes, journeys, events, and submissions plus journey/payment/authorization/reconciliation writes;
3. atomic one-time authorization consumption and payment/idempotency replay rejection;
4. exact unsigned authorization fields followed by recovered raw-signer/chain/nonce/target/calldata/value/gas matching and raw-hash binding;
5. server-authoritative activation, Permit2 approval, wrapper approval + execution, Router approval, and exact-output Router builders;
6. self-hosted EVM payment verifier/facilitator client injection;
7. bounded per-network submitter with target/selector, gas estimate, per-transaction cap, reserve floor, daily cap, idempotent success, pre-broadcast rejection, and unknown-result hard stop;
8. capped hollow-account funding, origin approval, provider submission/status, balance-delta arrival proof, and post-arrival destination requote;
9. separation of pre-payment activation/Permit2 approval from post-payment wrapper/Router authorization, with receipt confirmation before progression;
10. restart/scoped recovery that preserves in-flight grace, promotes only expired consumed-without-result records to review, and releases review state only from authoritative mirror evidence;
11. EIP-712 owner-consented bridge-hash adoption requiring provider confirmation, exactly one unbound matching destination credit, bounded ledger traversal, and account-scoped transaction serialization;
12. PostgreSQL advisory-lock serialization of concurrent startup migrations;
13. exact testnet/mainnet product harness through disposable PostgreSQL (Docker or explicit external override), local facilitator/proxy simulation, policy RPC, sponsor simulation, custom x402 challenge, bridge adoption, submission reconciliation, and final balance/receipt reconciliation.

Required at the mainnet enablement boundary:

1. same-release readback of deployed Permit2/proxy bytecode and the proxy's permit2/facilitator immutables (the payment recipient is a per-payment witness field, not an immutable);
2. accepted Squid and Saucer credential probes plus one eligible live provider/Saucer quote;
3. exact mainnet role/contract/runtime/cap bindings in the reviewed release artifact without exposing custody material;
4. facilitator `/health` and `/supported`, policy-RPC capability, sponsor reserve, target/selector, and public UI/API readback;
5. one low-value same-address wallet journey for product `live_proof`, including live gas, bridge arrival, settlement, destination balances, HBAR output, actual sponsor debit, and terminal reconciliation.

The six isolated role identities are funded and reconciled at component `live_proof`; that resolves only the role-account provisioning input. It does not satisfy any item above or authorize spending their balances.

Set `POLICY_RPC_AUTHORIZER_READY=1` and `POLICY_RPC_ENABLED=1` only after every remaining item is proven. Source or PostgreSQL migration success is not sufficient.

## Saucer, Mirror, and wrapper gates

Credential names are intentionally distinct: the host general secret is `SAUCERSWAP_PUBLIC_API_KEY`; the Refuel runtime contract is `SAUCERSWAP_API_KEY`. A no-output loader or deployment-secret injection may map the former to the latter only after an exact `/tokens` probe passes. Never duplicate the value into source, artifacts, logs, or argv. The reconciled canonical probe returned HTTP 200 with 1,529 token rows on 2026-07-22; deployment binding still requires secret-safe same-lane injection and authoritative Railway readback.

For each enabled destination asset:

- cache the complete token + V1/V2 pool graph for `SAUCERSWAP_GRAPH_CACHE_MS` (1–300 seconds), derived routes for `SAUCERSWAP_ROUTE_CACHE_MS` (1–60 seconds), and identical fresh quotes for `SAUCERSWAP_QUOTE_CACHE_MS` (0–30 seconds), all within `SAUCERSWAP_CACHE_MAX_ENTRIES`;
- coalesce identical in-flight graph and quote requests; do not start parallel duplicate upstream work;
- enumerate bounded non-cyclic complete-graph routes, rank V2 liquidity as a disclosure signal, and reject when candidates exceed `MAX_SAUCER_QUOTE_CANDIDATES` (hard maximum 32);
- run single-venue V1 router and V2 Quoter exact-output simulations at concurrency 1 with `SAUCERSWAP_QUOTE_SPACING_MS` enforced between calls; mixed-venue paths remain unsupported;
- bound maximum-HBAR evaluation by `MAX_HBAR_SOLVER_CANDIDATES`, reuse one timestamped gas/HBAR market snapshot, preserve the second-429 architecture hard stop, and expose the conservative result plus unresolved resolution;
- use Hedera's current official public `*_MIRROR_BASE_URL` for light readback and `/api/v1/contracts/call` simulations by default, with the full production call envelope (`method`, deployed read-only caller, gas, gas price, estimate flag, value). Never use a nonexistent/hollow destination EOA as the Quoter caller. Quote calls are serialized with bounded spacing and at most one 429 retry. The exact Railway wrapper has returned a live mainnet quote;
- on a read-only quote 429 only, honor `Retry-After`, apply capped exponential backoff + jitter, and make at most `MIRROR_QUOTE_429_MAX_ATTEMPTS=2` total attempts. A `Retry-After` beyond the configured ceiling stops without retry; a second bounded 429 is the architecture hard stop. Do not continue candidate simulation or create a retry loop;
- expire simulations independently with `SAUCERSWAP_QUOTE_MAX_AGE_MS` (1–60 seconds). Graph/route cache freshness never extends quote freshness; combined-quote expiry and intent construction must reject stale simulations;
- enforce liquidity/impact/slippage/amount/retained-balance policy and verify token keys/custom fees, Router/pool addresses, and exact calldata hashes;
- for WETH/WBTC, verify wrapper contract, counterpart, decimals, rate, approval, wrap output, and post-wrap balance.

## Mainnet gate

Mainnet requires an exact reviewed execution plan naming:

- provider/account/asset/amount;
- Permit2/proxy/facilitator state;
- policy-RPC/sponsor account and caps;
- wrapper/Router targets;
- blast radius and maximum HBAR/token exposure;
- stop conditions;
- verification and receipt artifacts;
- rollback/disable path.

`MAINNET_EXECUTION_ENABLED=1` is only a runtime lock; it is not approval.

### Serious-testing ramp profile

The approved production-testing profile stages `MAX_REFUEL_TINYBAR` through 10, 25, and 50 HBAR. Each stage must pass the repeatable `proof:economic-matrix` quote/readback before the next stage. At the 50-HBAR stage, the intended sponsor envelope is 15 HBAR per request, 75 HBAR rolling daily exposure, a 150 HBAR reserve floor, the existing 10 HBAR per-individual-transaction cap, unchanged 0.2 HBAR HAPI reserve per sponsored leg, and a 2,000,000 gas-limit ceiling for the empirically larger V1 HBAR path. Concurrent reservations remain charged against the daily cap. Roll back to the prior deployment and 2/8/10/25-HBAR cap set on the first failed stage.

## Supervised live proof

Run one low-value same-address journey.

Required evidence:

- product quote and expiry;
- MetaMask account before every signature/transaction;
- activation/association result when needed;
- provider origin transaction, status, and Hedera arrival;
- Permit2 allowance and x402 payment;
- wrapper and Saucer transactions;
- exact HBAR output and retained asset;
- sponsor actual exposure;
- PostgreSQL terminal reconciliation;
- authoritative explorer/provider links.

Stop on account drift, route/representation mismatch, unknown submission, stale quote, cap violation, or unverified payer.

## Existing-target release closeout

For an approved core release, deploy only the accepted standing commit to the existing Railway service and existing Pages project. Record the previous backend and Pages deployment IDs before mutation as rollback anchors. After each deploy, verify source/deployment identity, migrations, `/livez`, `/readyz`, mainnet options and live quote, custom x402 challenge, policy-RPC capability, CORS, CSP, rate limits, logs, UI-to-API wiring, deployment restart continuity, and the expected `executable` state. Do not touch usage limits or create resources.

A successful enabled release makes the user path available but does not transfer `live_proof` automatically from an older deployment. Each materially changed deployed generation needs authoritative same-release readback and a wallet-authorized terminal journey before it inherits that predicate.

## Post-test cleanup

After the bounded test window:

1. disable all execution flags;
2. retain receipts, lifecycle export, and minimal redacted logs;
3. revoke/rotate temporary provider/facilitator/sponsor credentials;
4. decide keep/pause/remove for Railway and PostgreSQL;
5. pause services before trial billing if no continued decision exists;
6. remove unused Reown/QuickNode/provider projects if any were explicitly created later;
7. leave immutable contracts disabled at the application/support layer;
8. update the resource ledger and product support catalog.
