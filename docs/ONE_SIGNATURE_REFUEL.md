# One-signature refuel authorization

## Product contract

For an eligible journey, the owner signs one `Refuel402RefuelAuthorization` Permit2 witness while MetaMask is on Hedera. The witness binds:

- owner and destination recipient (they must be the same address);
- destination token;
- combined maximum token spend;
- exact HBAR output;
- fixed Refuel402 service fee;
- deterministic journey nonce;
- two-hour deadline;
- hash of the wrapper/direct-token, HTS input, router, WHBAR, conversion rate, and pool fee tier.

The signature is recorded before the source bridge is submitted. After authoritative arrival, the existing server sweeper owns the continuation. It refreshes the destination route, refuses execution above the signed cap, simulates the exact proxy calldata, and submits one sponsor-paid HAPI contract call. The proxy atomically pulls no more than the cap, pays the fixed service fee, wraps when required, buys and unwraps the exact HBAR output, returns all unused value to the owner, and retains zero token dust.

A price/cap miss is not permission to spend more. The server follows bounded delays of 30 seconds, 1 minute, 2 minutes, and 5 minutes while the authorization remains live. Expiry or a definitive incompatibility returns the journey to the existing `destination_wallet_consent` flow. An unknown submission result is never retried blindly.

## Price protection

`config/refuel-price-protection.json` is the canonical policy:

- Flexible: `clamp(800 + 60 × provider ETA minutes, 800, 3500)` basis points;
- Balanced: half the Flexible buffer, bounded by the 500 basis-point strict floor;
- Strict: 500 basis points;
- Custom: exact owner-entered maximum.

The cap includes the fixed service fee and buffered exact-output swap input. It is not an estimate of what will be spent. Quotes publish current expected input and the authorization maximum in token units and USD when market evidence exists.

## First-use Permit2 prerequisite

Permit2 SignatureTransfer can move the owner's token only when the token contract already grants Permit2 enough ERC-20 allowance. The witness does not create that token allowance. Therefore the literal one-prompt path has a hard prerequisite: sufficient standing allowance to the network's canonical Permit2 address.

This is not hidden or bypassed. If allowance is absent or insufficient, pre-authorization may not be treated as live product acceptance. The journey remains safe and uses the existing manual destination flow, where the owner explicitly approves the token before settlement. A future first-use flow may establish a standing allowance through a separately disclosed wallet transaction, but it is not part of the one-signature claim.

## Unsigned endpoint threat model

`POST /v1/product/quote` and `POST /v1/product/journeys` remain unsigned staging endpoints. They can create bounded PostgreSQL quote/journey records but cannot sign, bridge, settle, submit, swap, sponsor, or move owner funds. They are rate-limited, bind immutable quote/account/provider identity, and reject idempotency-key reuse with changed fields.

Every mutation that crosses a wallet or external execution boundary is independently authorized:

- source activation, quote refresh/rebind, and bridge submission require the owner’s source-leg EIP-712 consent;
- bridge adoption requires its dedicated owner consent;
- autonomous destination execution requires the Hedera-domain Permit2 witness above;
- manual destination execution requires fresh Hedera transaction/payment signatures.

Database allocation spam is an availability concern, not execution authority. Rate limits, bounded activity reads, and retention policy contain it; an unsigned staging row is never interpreted as owner consent.

## Operational gates

`REFUEL_PREAUTHORIZATION_ENABLED=1` is accepted only after the deployed proxy runtime/immutables, Permit2, wrapper/direct HTS token, router, pool, sponsor reserve, migration, executor simulation, and a bounded live journey are proven for that deployed generation. The current deployed mainnet generation passed those gates and completed terminal journeys; the newer donation-resistant local source has not been deployed and therefore carries only local/integration acceptance.

Contract deployment alone does not enable autonomous execution. The manual path remains authoritative whenever any precondition is absent, and every future release must re-prove the same runtime and receipt predicates.
