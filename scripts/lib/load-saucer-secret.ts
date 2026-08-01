import dotenv from "dotenv";

export type SaucerCredentialSource =
  | "SAUCERSWAP_API_KEY"
  | "SAUCERSWAP_PUBLIC_API_KEY_alias"
  | "missing";

/**
 * Loads the host general Saucer public API secret without printing or copying it.
 * Refuel consumes only the process-local SAUCERSWAP_API_KEY alias. Railway uses
 * its own secret-injection lane and never reads the host file directly.
 */
export function loadSaucerApiCredential(): SaucerCredentialSource {
  const envFile = process.env.SAUCERSWAP_API_ENV_FILE;
  if (envFile) dotenv.config({ path: envFile, override: false });
  if (process.env.SAUCERSWAP_API_KEY?.trim()) return "SAUCERSWAP_API_KEY";
  const publicKey = process.env.SAUCERSWAP_PUBLIC_API_KEY?.trim();
  if (!publicKey) return "missing";
  process.env.SAUCERSWAP_API_KEY = publicKey;
  return "SAUCERSWAP_PUBLIC_API_KEY_alias";
}
