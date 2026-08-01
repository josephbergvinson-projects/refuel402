// One-time key generation for the testnet demo. Writes .env (gitignored).
// The sponsor address must be funded once via https://portal.hedera.com/faucet
// (human action: the faucet is captcha-gated by design).
import { PrivateKey } from "@hiero-ledger/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath) && process.argv[2] !== "--force") {
  console.log(".env already exists; refusing to overwrite (use --force)");
  process.exit(1);
}

const sponsor = PrivateKey.generateECDSA();
const user = PrivateKey.generateECDSA();

const env = `# Refuel402 testnet demo keys — generated ${new Date().toISOString()}
# TESTNET ONLY. Never fund these on mainnet.
HEDERA_NETWORK=testnet
SPONSOR_PRIVATE_KEY=0x${sponsor.toStringRaw()}
SPONSOR_EVM_ADDRESS=0x${sponsor.publicKey.toEvmAddress()}
# SPONSOR_ACCOUNT_ID is resolved automatically after faucet funding (mirror node lookup)
SPONSOR_ACCOUNT_ID=
DEMO_USER_PRIVATE_KEY=0x${user.toStringRaw()}
DEMO_USER_EVM_ADDRESS=0x${user.publicKey.toEvmAddress()}
FACILITATOR_URL=https://api.testnet.blocky402.com
PORT=4020
`;
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log("Wrote", envPath);
console.log("");
console.log("FAUCET ACTION REQUIRED (30 seconds, once):");
console.log("  1. Open https://portal.hedera.com/faucet");
console.log(`  2. Paste: 0x${sponsor.publicKey.toEvmAddress()}`);
console.log("  3. Complete the captcha and dispense.");
console.log("");
console.log("Then run: npx tsx scripts/resolve-accounts.ts");
