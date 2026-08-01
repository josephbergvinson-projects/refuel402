// After the sponsor EVM address is funded via https://portal.hedera.com/faucet,
// resolve its auto-created account id, complete the hollow account, and persist
// SPONSOR_ACCOUNT_ID into .env.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

const evm = process.env.SPONSOR_EVM_ADDRESS;
const key = process.env.SPONSOR_PRIVATE_KEY;
if (!evm || !key) throw new Error("run scripts/keygen.ts first");

const res = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${evm}`);
if (!res.ok) {
  console.error(`No account found for ${evm} yet (mirror ${res.status}).`);
  console.error("Fund it first: https://portal.hedera.com/faucet");
  process.exit(1);
}
const acct = (await res.json()) as { account: string; balance: { balance: number } };
console.log(`Sponsor account: ${acct.account}, balance ${acct.balance.balance / 1e8} HBAR`);

// Complete the hollow account by having it pay for a trivial self-transfer.
const client = Client.forTestnet().setOperator(
  AccountId.fromString(acct.account),
  PrivateKey.fromStringECDSA(key),
);
const receipt = await (
  await new TransferTransaction()
    .addHbarTransfer(acct.account, Hbar.fromTinybars(-1))
    .addHbarTransfer("0.0.98", Hbar.fromTinybars(1))
    .execute(client)
).getReceipt(client);
console.log(`Hollow-account completion transfer: ${receipt.status.toString()}`);

let env = fs.readFileSync(envPath, "utf8");
env = env.replace(/^SPONSOR_ACCOUNT_ID=.*$/m, `SPONSOR_ACCOUNT_ID=${acct.account}`);
fs.writeFileSync(envPath, env, { mode: 0o600 });
console.log(`Wrote SPONSOR_ACCOUNT_ID=${acct.account} to .env`);
client.close();
