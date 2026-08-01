# Refuel402 demo

## Public recording

<https://drive.google.com/drive/folders/1jitCwXlTOeT_wffuPbCLswKwGLNcjD-2>

The folder is anonymously readable and contains `Refuel402 Demo.mp4`, a 94.628-second (1:34.628) MP4, listed as 22.6 MB in Drive. The repository does not mirror the video binary.

## Evidence boundaries

A demo should keep three claims separate:

1. **Public application:** the UI and API are reachable at <https://refuel402.pages.dev>.
2. **Deployed evidence:** the deployment registry and linked HashScan receipts prove completed mainnet refuels on the deployed source generation.
3. **Current source:** deployed and runtime-verified on both networks, with completed mainnet refuels against the mainnet proxy. There is no EVM execution test in this repository; the contract's behaviour is carried by those on-chain journeys.

The manual destination path uses an HTTP 402 `exact` Permit2 challenge and settlement. The pre-authorized path instead signs a `RefuelAuthorization` before the bridge and collects the bounded service fee inside the atomic `executeRefuel` call. A recording should not describe those as the same wire flow.

## Suggested walkthrough

1. Open the unified compose card and show `bridge_only` versus `bridge_plus_refuel`.
2. Show provider, origin network, asset, source amount, desired HBAR, retained balance, route, fee, slippage, and blocker disclosures.
3. Show Testnet disabled with its concrete route blockers rather than implying a working full testnet journey.
4. Show a Mainnet route preview and the same MetaMask address as origin sender and Hedera recipient.
5. Open the developer surface for policy-RPC, OpenAPI, and x402 discovery links.
6. Show one linked mainnet `RefuelExecuted` receipt and the local executable EVM proof output.
7. End on the known limits in [`SUBMISSION.md`](../SUBMISSION.md).

## Deterministic checks before recording

```bash
npm ci
npm run check
npm run e2e:product-harness
npm run contracts:evm-test
```

Release acceptance runs the exact product harness twice against disposable PostgreSQL. Never point `HARNESS_DATABASE_URL` or `TEST_DATABASE_URL` at production or shared state.
