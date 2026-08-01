// Security-review F1: the fee floor must dominate the sponsor's worst-case
// loss on an ABORTED EthereumTransaction (pre-EVM due-diligence failure, e.g.
// WRONG_NONCE), which HIP-1084 charges to the payer. That number was an
// assumption ("<= 1 HBAR"); this script MEASURES it on testnet.
//
// It signs a syntactically valid tx with a deliberately wrong (far-future)
// nonce from a throwaway key, submits it sponsored, and reports exactly what
// the sponsor account was charged. Run once after funding; set FEE_FLOOR_TINYBAR
// in .env to comfortably exceed the printed value.
import "dotenv/config";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import { buildApproveCalldata, signRawTx, userAddress } from "../client/src/txbuilder.js";
import { SponsorClient } from "../server/src/hedera.js";
import { TESTNET, TOKENS } from "../server/src/config.js";

const sponsorId = process.env.SPONSOR_ACCOUNT_ID!;
const sponsorKey = process.env.SPONSOR_PRIVATE_KEY!;
if (!sponsorId || !sponsorKey) throw new Error("fund + resolve the sponsor first");

const throwaway = generatePrivateKey();
console.log(`throwaway signer: ${userAddress(throwaway)} (account does not exist)`);

// Nonexistent EOA => HIP-1084 due-diligence failure charged to the payer.
const raw: Hex = await signRawTx({
  privateKey: throwaway,
  chainId: TESTNET.chainId,
  to: TOKENS.USDC!.evmAddress,
  data: buildApproveCalldata(TESTNET.router, 1n),
  nonce: 7, // also wrong for good measure
  gasLimit: 800_000n,
  maxFeePerGas: 0n,
});

const sponsor = new SponsorClient("testnet", sponsorId, sponsorKey);
try {
  const out = await sponsor.submitSponsored(raw, 1_000_000_000n);
  console.log(`status: ${out.status}`);
  console.log(`sponsor charged: ${out.sponsorPaidTinybar} tinybar (${Number(out.sponsorPaidTinybar) / 1e8} HBAR)`);
  console.log(`tx: ${TESTNET.hashscanBase}/transaction/${out.hederaTransactionId}`);
  console.log(`\nSet FEE_FLOOR_TINYBAR comfortably above ${out.sponsorPaidTinybar} (e.g. 2-3x).`);
} catch (e) {
  // Precheck rejections (never reached consensus) cost nothing; that is also an answer.
  console.log(`submission threw before consensus: ${(e as Error).message}`);
  console.log("If this was a pure precheck rejection, the abort charge for this class is 0.");
} finally {
  await sponsor.close();
}
