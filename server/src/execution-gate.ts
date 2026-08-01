export function runtimeExecutionEnabled(
  env: NodeJS.ProcessEnv,
  network: "testnet" | "mainnet",
): boolean {
  return env.SAME_WALLET_EXECUTION_ENABLED === "1" &&
    !!env.SPONSOR_ACCOUNT_ID &&
    !!env.SPONSOR_PRIVATE_KEY &&
    (network === "testnet" || env.MAINNET_EXECUTION_ENABLED === "1");
}
