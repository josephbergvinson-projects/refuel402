# Refuel402 security model

The product contract is [`PRODUCT.md`](PRODUCT.md). This document defines the trust boundaries and fail-closed controls for the same-wallet architecture.

## Assets and principals

### User

One stock MetaMask ECDSA account is:

- origin bridge sender;
- Hedera EVM alias/destination;
- x402 payer;
- destination transaction sender;
- HBAR recipient.

Refuel402 never imports, exports, stores, or receives the user’s private key.

### Refuel sponsor

The sponsor pays tightly bounded Hedera transaction costs. It must not become a general public relay.

### x402 facilitator

The facilitator verifies an EIP-712 exact payment and pays settlement gas through the canonical exact proxy. It does not receive a user key.

### Provider and Saucer routes

Bridge providers, token contracts, wrappers, pools, and Router contracts are external dependencies. A provider listing or token symbol is not sufficient support evidence.

## Browser boundary

Allowed wallet methods:

- `eth_requestAccounts`
- `eth_accounts`
- `eth_chainId`
- `eth_call` (ERC-20 `balanceOf` / `allowance` reads only)
- `eth_getBalance`
- `eth_getTransactionReceipt`
- `wallet_switchEthereumChain`
- `wallet_addEthereumChain`
- `wallet_revokePermissions` (Disconnect only; failure is tolerated because it is a MetaMask extension, not EIP-1193)
- `eth_sendTransaction`
- `eth_signTypedData_v4`

Forbidden in the product path:

- raw transaction signing requests;
- native Hedera transaction signing;
- private-key import/export;
- a second wallet or pasted destination;
- browser-held provider, Saucer, sponsor, or facilitator secrets.

Every quote and intent binds the normalized connected address, requested provider policy, selected provider, asset, and origin chain. Account, chain, provider, or asset drift invalidates it. An explicit provider can never fall back to another provider; `Auto` may compare only candidates in the same declared comparison group.

## HTTP abuse boundary

Rate-limit identities use a validated IP value. On Railway, the service trusts the platform-overwritten single-value `X-Real-IP` only when Railway environment identity is present; it never trusts arbitrary `X-Forwarded-For`. Reviewed non-Railway proxies may opt in only when they also overwrite `X-Real-IP`. Otherwise the socket/Express address is used. Lifecycle, read, demo, and fuel limiters share this resolver so edge-proxy fan-out cannot multiply one client’s allowance.

## Same-address invariant

The backend and browser independently assert:

```text
fromAddress == toAddress == Hedera destination
bridge_plus_refuel only: == x402 payer == transaction sender == HBAR recipient
```

The bridge adapter constructs `fromAddress` and `toAddress` from one account field; it does not accept an independent destination.

## Support intersection

`bridge_only` becomes executable when the provider route/transaction builder, same-address delivery/activation class, exact destination representation, token risk, and selected-network execution gate pass. Saucer, wrapper, x402, facilitator, and sponsor readiness are not bridge-only predicates.

`bridge_plus_refuel` additionally requires:

1. user-selected desired HBAR plus a bounded server-verified maximum on a venue-specific Saucer V1 or V2 exact-output path; mixed-venue paths remain unsupported;
2. every hop's venue/version, pool/contract, fee, liquidity evidence, price impact, and maximum slippage disclosed for explicit consent;
3. standard EVM x402 compatibility and required contracts;
4. sponsorship for every exact target/phase;
5. retained-value, balance, reserve, per-request, per-leg gas/HAPI, rolling daily, and active concurrent-reservation policy gates.

Missing/stale/contradictory evidence disables execution. Static catalogs never override a failed live probe.

## Hollow-account and association boundary

A newly bridged EVM alias may be nonexistent or hollow. Refuel402 records one provider-specific arrival class:

- `arrival_auto_create_proven`;
- `activation_required`;
- `arrival_unproven`.

For `activation_required`, only these pre-payment actions may be sponsored:

1. a bounded HBAR transfer that creates the hollow account; and
2. an exact MetaMask-signed completion/association or Permit2-approval transaction tied to a quote.

This bootstrap surface needs strict IP/account/device rate limits, low daily caps, expiry, one-time use, and abuse monitoring. A generic HBAR faucet is forbidden.

## Policy RPC

MetaMask signs and internally submits the transaction to `/rpc/<mode>`. The dapp never receives raw signed bytes.

Read methods proxy to the configured upstream. `eth_sendRawTransaction` is accepted only if its hash maps to an unconsumed PostgreSQL authorization binding:

- immutable journey/quote/payment identity;
- mode and chain ID;
- recovered sender;
- nonce;
- target;
- calldata hash;
- value;
- gas-limit maximum;
- maximum sponsor allowance;
- phase and expiry.

The intent builder persists exact unsigned fields and the matching quote execution-leg gas allowance. A missing leg fails closed, and a destination intent never receives the global allowance cap as a substitute. One authoritative rolling exposure reader sums every path paid by the HAPI sponsor account: legacy sponsorships, destination activation funding, and live or realized policy-RPC allowances. Facilitator-paid x402 settlement remains separate. Activation writes an immutable amount-bearing marker before any HBAR transfer; the daily ledger charges the per-journey maximum of the marker and funded event so a transfer/readback crash cannot hide spend. Live pending authorizations reserve their allowance, a newer authorization for the same journey/intent expires the never-broadcast predecessor, consumed/submitted/unknown rows remain charged, and mined-reverted rows remain charged because sponsor-paid gas was burned. The submitter excludes only the consumed authorization it is currently deciding on, preventing self-double-counting while retaining all other exposure.

After MetaMask signs, the policy RPC recovers the raw sender, matches chain/nonce/target/calldata/value/gas against exactly one pending authorization, atomically binds the raw hash, and consumes it once. The verifier rejects sender, chain, nonce, target, calldata, value, gas, fee, expiry, and authorization mismatches. Inner gas price must be zero. Any estimate/reserve/exposure read failure before broadcast is a fail-closed rejection, not an unknown submission. A pre-broadcast target/selector/cap/reserve rejection is recorded as `rejected`; only a sponsor transport/result ambiguity is `unknown`, and restart recovery moves consumed-without-result journeys to review rather than retrying.

### Required target policy

At minimum, targets must be classified separately:

- HTS facade for association/approval;
- canonical Permit2;
- canonical x402 exact proxy (facilitator only);
- Saucer ERC20 wrapper for configured ERC20 assets;
- Saucer V2 Router;
- narrowly reviewed activation/no-op target if used.

Contract-level whitelisting alone is insufficient for a general endpoint. Calldata and value are bound per authorization.

## x402 EVM exact

The product uses `scheme=exact`, `network=eip155:<Hedera chain id>`, and `assetTransferMethod=permit2`.

The payment requirements bind:

- asset address;
- exact amount;
- payee;
- Permit2 spender/exact proxy;
- validity window and nonce;
- payer account;
- quote/journey context.

Before prompting a signature, the browser displays fee asset/amount/payee and verifies the response belongs to the active quote. The server rejects altered requirements or replayed payments.

`Refuel402ExactPermit2Proxy` is the only settlement proxy path. Its Permit2 witness binds payer, token, amount, recipient, chain ID, nonce, deadline, proxy spender, and quote context hash. Only the immutable facilitator may call settlement. The payment ID is marked consumed before the Permit2 transfer call, guarded against reentrancy, and emitted with the full non-secret proof identity. Reverts are atomic; no parallel proxy or fallback transfer path exists.

HTS assets expose ERC20-compatible allowance/transfer methods through the token facade, but are not assumed to support EIP-2612 or EIP-3009. Permit2 and proxy bytecode readiness are probed independently per network.

## Quote and value bounds

The combined quote must include:

- source input, bridge/provider fee, and bridge gas/relayer fee in source units;
- gross and minimum bridge arrival in destination units;
- maximum destination conversion input;
- x402 fee;
- minimum retained destination asset and effective destination difference;
- exact and minimum HBAR output;
- slippage and price impact;
- sponsor exposure by leg;
- payer/asset for every fee;
- expiry and evidence freshness.

Execution rejects:

- insufficient minimum arrival;
- debit greater than authorized maximum;
- retained balance below policy;
- impact/slippage/liquidity violations;
- stale provider or Saucer quotes;
- changed balance/allowance/nonce;
- sponsor reserve/request/daily cap violations.

## Bridge risks

Provider quotes and statuses are untrusted external data until validated.

Controls:

- server-side integrator credential;
- allowlisted provider hosts;
- bounded timeouts and response sizes;
- schema validation and redacted errors;
- same-address rewrite/verification;
- transaction target/value checks against provider evidence;
- explicit expected destination representation;
- asynchronous idempotency: never blind-resubmit after an unknown result;
- authoritative provider plus Hedera arrival readback.

## ERC20-to-HTS wrapper risks

LayerZero WETH/WBTC arrive as contract tokens and require a Saucer wrapper before HTS pool execution.

Controls:

- exact wrapper contract, HTS counterpart, decimals, and on-chain rate;
- wrapper approval amount bound to quote maximum;
- minimum HTS output/rounding reserve;
- wrapper target and calldata hash authorization;
- successful exact wrapper receipt before Router approval/swap, followed by terminal retained-asset and HBAR balance reconciliation;
- no symbol-only counterpart selection.

## Quote arithmetic and cost separation

The quote solver is server-authoritative and bounded by a fixed candidate budget. Source policy can evaluate up to 50 HBAR, but this does not activate the production cap; live-cap change remains a separately approved configuration mutation. It preserves the Mirror concurrency-one scheduler, quote spacing and second-429 architecture hard stop. The reported maximum is a verified feasible candidate on the selected V2 route; any unresolved interval is returned as `solverResolutionTinybar` rather than hidden as fake precision.

Source-token conservation, destination-token conservation and sponsor HBAR exposure are separate domains. Provider fee components that overlap transaction value or the source-to-arrival difference are disclosed but not added twice. Cost rows must identify one funding source: `user_origin`, `deducted_from_bridge`, `sponsor`, or `included_in_swap`. Native gas and token amounts are never summed, and no fiat total is emitted without a complete same-time price set.

## Lifecycle and replay

PostgreSQL is required for production and owns:

- immutable journey, quote, route mode, requested/selected provider and asset, support, payment, authorization, and submission identities;
- append-only pre-wallet markers before origin approval and bridge consent;
- owner-scoped local pointer to the server journey ID, never written to the URL (pointer only; server state is authoritative);
- payment replay keys;
- account/nonce locks;
- one-time authorization consumption;
- a durable submission-attempt row created atomically at consumption time;
- append-only lifecycle events;
- restart conversion of consumed-without-result attempts to `unknown`/manual review;
- bridge and chain idempotency;
- sponsor per-request, per-leg gas/HAPI, reserve, rolling daily, and active concurrent-reservation caps;
- terminal receipt/refund reconciliation and one append-only `journey_reconciled` event.

Journey JSON responses serialize bigint authorization fields as decimal strings; raw payment headers, signatures, signed transactions, and private keys never enter reader-facing journey records.

Local JSON is test-only.

## Failure and refunds

The receipt distinguishes:

- bridge submitted/not submitted/unknown;
- destination arrival confirmed/not confirmed;
- x402 verified/settled/failed/unknown;
- sponsor leg submitted/not submitted/unknown;
- HBAR output confirmed/not confirmed;
- x402 fee consumed/refundable/refunded;
- user and sponsor debits.

A refresh may replay only provider/destination polling after a durable source hash. A wallet boundary without a stored hash, an unknown policy-RPC submission, or an account mismatch hard-stops that selected journey. The browser never auto-signs or auto-resubmits. Unknown external state is not retried automatically. Local storage contains only a versioned per-account active journey pointer, and the app never writes that ID into the address bar; quotes, form values, events, recovery decisions, Activity data, payment/submission references, and evidence remain server-authoritative. A stored pointer is not treated as consent to resume: it takes the primary screen by itself only when the server reports a bridge already in flight, and is otherwise a dismissible offer above an untouched draft. Account-scoped Activity is a bounded read, and selecting one row is the only history-to-primary transition. Starting a new transfer removes only the local pointer and strips a `?journey=` link if one was opened. One explicit destination continuation adds/switches the policy-RPC network once and reuses it across its sponsored legs; stable provider listener references are registered and removed once. Malformed provider results and error fields are typed before string operations. Extension-owned multiplex warnings are not treated as application state. Refund eligibility depends on whether settlement occurred and whether a sponsored attempt consumed value; the decision must be recorded against authoritative evidence.

## Secret handling

Never log or persist in source/artifacts:

- sponsor/facilitator/private keys;
- provider or Saucer API keys;
- PostgreSQL DSNs;
- raw x402 payment headers;
- raw signed transactions;
- wallet cookies/session tokens.

No secret belongs in `VITE_*`. Error bodies sent to the browser are normalized and do not include provider response bodies or request headers.

## Pre-authorized refuel boundary

The complete threat model and product contract are in `ONE_SIGNATURE_REFUEL.md`. The signed maximum is a hard upper bound, not a target debit. Route contracts/tokens/rate/fee tier, exact HBAR output, fixed fee, owner/recipient, journey nonce, and deadline are witness-bound. The proxy is permissionless to relay but cannot change those terms, consumes the authorization before external calls, rejects reentrancy/replay, and restores the proxy's entry balance baselines so the call retains no new token dust. Server retries are permitted only before dispatch on a live signature and fresh route simulation; an unknown dispatch is terminal for automation. Permit2 still requires standing ERC-20 allowance, so no first-use one-prompt claim is valid without authoritative allowance readback.

## Mainnet boundary

Mainnet requires all source checks plus:

- explicit reviewed deployment approval with contract, account, target, budget, and stop conditions;
- Permit2 and x402 proxy deployment/verification;
- facilitator and policy-RPC live proof;
- provider quote/execution readback;
- wrapper and Saucer route proof;
- bounded sponsor and rollback/stop conditions;
- a low-value same-address supervised run;
- reconciliation and receipt.

`MAINNET_EXECUTION_ENABLED=1` alone is not approval or proof.

## Completion boundary

Finishing the product contract, deployment topology, one-wallet shell, and PostgreSQL lifecycle does not by itself establish whole-product provider or chain safety. Static catalogs record intrinsic route evidence only; every release must derive provider, contract, facilitator, sponsor, execution-mode, wallet-consent, and reconciliation gates from fresh runtime proof. The deployed mainnet generation has authoritative terminal journeys and may be described at `live_proof`; the newer donation-resistant local source remains at local/integration acceptance until it is separately deployed and read back.

## Dependency posture

`npm audit --omit=dev` currently reports 8 advisories (6 high, 2 moderate). Every one is transitive and reaches the tree through the Hedera stack rather than through Refuel402 code:

- `@hiero-ledger/sdk` → `@grpc/grpc-js`, `protobufjs`
- `@x402/hedera` → `@hiero-ledger/proto` → `protobufjs`
- `@hashgraph/hedera-agent-kit` → `ethers` → `ws`

None is reachable from an untrusted input path in this product: the SDK is used server-side against Hedera's own endpoints with operator credentials, and no advisory affects the browser bundle, which ships no Hedera SDK. They are listed here rather than suppressed, and they resolve when the upstream Hedera packages publish fixes.

## Reporting

Please open a GitHub issue for anything that is not exploitable, and contact the maintainer privately for anything that is. This project moves real funds on Hedera mainnet; a report that includes a reproduction against testnet, or against a local harness, is far more useful than one against mainnet.
