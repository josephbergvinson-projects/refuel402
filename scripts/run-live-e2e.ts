// Live testnet acceptance path. The client uses the stock x402 Hedera client,
// retries the canonical POST /v1/fuel wrapper, and writes HashScan-linked proof.
if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") {
  throw new Error("mainnet live execution is not authorized");
}
if (!process.env.DEMO_USER_PRIVATE_KEY || !process.env.SPONSOR_ACCOUNT_ID) {
  throw new Error("personally owned, funded testnet user and sponsor credentials are required");
}
await import("../client/src/demo.js");
