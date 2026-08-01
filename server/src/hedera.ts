// Sponsor-side Hedera integration: submits user-signed raw EVM transactions via
// the native EthereumTransaction wrapper, with the sponsor account as fee payer.
import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  EthereumTransaction,
  Hbar,
  HbarUnit,
  AccountId,
  PrivateKey,
  TokenId,
  TransactionRecordQuery,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { Hex } from "viem";

export type SponsorSubmission = {
  hederaTransactionId: string;
  ethereumHash: Hex | null;
  status: string;
  /** What the sponsor actually paid, in tinybar (network fee + gas allowance used) */
  sponsorPaidTinybar: bigint;
  consensusTimestamp: string | null;
  /** Full HBAR transfer list from the record: proves exactly who paid and who received */
  transfers: { account: string; tinybar: string }[];
};

export class SponsorClient {
  readonly client: Client;
  readonly operatorId: AccountId;

  constructor(network: "testnet" | "mainnet", operatorId: string, operatorKey: string) {
    this.client = network === "testnet" ? Client.forTestnet() : Client.forMainnet();
    this.operatorId = AccountId.fromString(operatorId);
    this.client.setOperator(this.operatorId, PrivateKey.fromStringECDSA(operatorKey));
  }

  /**
   * Submit a raw signed EVM transaction with this sponsor as the HAPI fee payer.
   * maxGasAllowanceTinybar bounds what the sponsor is willing to cover for EVM gas
   * when the inner transaction's own gas price is zero/insufficient.
   */
  async submitSponsored(rawTx: Hex, maxGasAllowanceTinybar: bigint): Promise<SponsorSubmission> {
    const ethBytes = Buffer.from(rawTx.slice(2), "hex");
    const tx = new EthereumTransaction()
      .setEthereumData(ethBytes)
      .setMaxGasAllowanceHbar(Hbar.from(maxGasAllowanceTinybar.toString(), HbarUnit.Tinybar));

    const response = await tx.execute(this.client);
    // getRecord throws on non-SUCCESS receipts; we want the record either way to
    // report exactly what happened and what the sponsor paid.
    let status = "UNKNOWN";
    let record;
    try {
      record = await response.getRecord(this.client);
      status = record.receipt.status.toString();
    } catch (e) {
      try {
        record = await new TransactionRecordQuery()
          .setTransactionId(response.transactionId)
          .setValidateReceiptStatus(false)
          .execute(this.client);
        status = record.receipt.status.toString();
      } catch {
        throw e;
      }
    }

    let sponsorPaid = 0n;
    const transfers: { account: string; tinybar: string }[] = [];
    for (const transfer of record.transfers) {
      const tb = BigInt(transfer.amount.to(HbarUnit.Tinybar).toFixed(0));
      transfers.push({ account: transfer.accountId.toString(), tinybar: tb.toString() });
      if (transfer.accountId.toString() === this.operatorId.toString() && tb < 0n) {
        sponsorPaid += -tb;
      }
    }

    return {
      hederaTransactionId: response.transactionId.toString(),
      ethereumHash: record.ethereumHash?.length
        ? (("0x" + Buffer.from(record.ethereumHash).toString("hex")) as Hex)
        : null,
      status,
      sponsorPaidTinybar: sponsorPaid,
      consensusTimestamp: record.consensusTimestamp?.toString() ?? null,
      transfers,
    };
  }

  /** Execute one server-owned contract call with bounded gas and transaction fee. */
  async executeContractCall(input: {
    contract: string;
    calldata: Hex;
    gas: bigint;
    maxTransactionFeeTinybar: bigint;
    memo: string;
  }): Promise<SponsorSubmission> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.contract)) throw new Error("contract call target is invalid");
    if (!/^0x[0-9a-fA-F]*$/.test(input.calldata)) throw new Error("contract call calldata is invalid");
    const gasLimit = BigInt(process.env.REFUEL_EXECUTION_GAS_LIMIT_MAX ?? 4_000_000n);
    const feeLimit = BigInt(process.env.REFUEL_EXECUTION_MAX_FEE_TINYBAR ?? 1_500_000_000n);
    if (input.gas <= 0n || input.gas > gasLimit) throw new Error("contract call gas exceeds policy");
    if (input.maxTransactionFeeTinybar <= 0n || input.maxTransactionFeeTinybar > feeLimit) {
      throw new Error("contract call transaction fee exceeds policy");
    }
    const tx = new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, input.contract))
      .setGas(Number(input.gas))
      .setFunctionParameters(Buffer.from(input.calldata.slice(2), "hex"))
      .setMaxTransactionFee(Hbar.from(input.maxTransactionFeeTinybar.toString(), HbarUnit.Tinybar))
      .setTransactionMemo(input.memo.slice(0, 100));
    const response = await tx.execute(this.client);
    let status = "UNKNOWN";
    let record;
    try {
      record = await response.getRecord(this.client);
      status = record.receipt.status.toString();
    } catch (error) {
      try {
        record = await new TransactionRecordQuery()
          .setTransactionId(response.transactionId)
          .setValidateReceiptStatus(false)
          .execute(this.client);
        status = record.receipt.status.toString();
      } catch {
        throw error;
      }
    }
    let sponsorPaid = 0n;
    const transfers: { account: string; tinybar: string }[] = [];
    for (const transfer of record.transfers) {
      const tinybar = BigInt(transfer.amount.to(HbarUnit.Tinybar).toFixed(0));
      transfers.push({ account: transfer.accountId.toString(), tinybar: tinybar.toString() });
      if (transfer.accountId.toString() === this.operatorId.toString() && tinybar < 0n) sponsorPaid += -tinybar;
    }
    return {
      hederaTransactionId: response.transactionId.toString(),
      ethereumHash: record.ethereumHash?.length
        ? (("0x" + Buffer.from(record.ethereumHash).toString("hex")) as Hex)
        : null,
      status,
      sponsorPaidTinybar: sponsorPaid,
      consensusTimestamp: record.consensusTimestamp?.toString() ?? null,
      transfers,
    };
  }

  /** Create a hollow EVM-alias account with a tightly bounded HBAR transfer. */
  async activateAlias(
    to: string,
    amountTinybar: bigint,
  ): Promise<{ transactionId: string; status: string }> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("destination activation requires an EVM address");
    const minimum = 1n;
    const maximum = BigInt(process.env.DESTINATION_ACTIVATION_MAX_TINYBAR ?? 50_000_000n);
    if (amountTinybar < minimum || amountTinybar > maximum) throw new Error("destination activation amount exceeds policy");
    const recipient = AccountId.fromEvmAddress(0, 0, to);
    const tx = await new TransferTransaction()
      .addHbarTransfer(this.operatorId, Hbar.from((-amountTinybar).toString(), HbarUnit.Tinybar))
      .addHbarTransfer(recipient, Hbar.from(amountTinybar.toString(), HbarUnit.Tinybar))
      .setTransactionMemo("Refuel402 destination activation")
      .execute(this.client);
    const receipt = await tx.getReceipt(this.client);
    return { transactionId: tx.transactionId.toString(), status: receipt.status.toString() };
  }

  /**
   * Send an HTS token to an account (or EVM alias — which auto-creates a hollow
   * account with 0 HBAR). Used by the demo's labeled testnet "bridge arrival"
   * stand-in to birth a stranded account. Sponsor pays the network fee.
   */
  async sendToken(
    tokenId: string,
    to: string,
    amount: bigint,
  ): Promise<{ transactionId: string; status: string }> {
    const recipient = to.startsWith("0x")
      ? AccountId.fromEvmAddress(0, 0, to)
      : AccountId.fromString(to);
    const tx = await new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenId), this.operatorId, -Number(amount))
      .addTokenTransfer(TokenId.fromString(tokenId), recipient, Number(amount))
      .setTransactionMemo("refuel402 demo: simulated bridge arrival (testnet)")
      .execute(this.client);
    const receipt = await tx.getReceipt(this.client);
    return { transactionId: tx.transactionId.toString(), status: receipt.status.toString() };
  }

  /**
   * Return a collected x402 fee to the payer after a post-settlement failure.
   * The sponsor pays this transfer's (sub-cent) network fee.
   */
  async refundToken(
    tokenId: string,
    toAccountId: string,
    amount: bigint,
  ): Promise<{ transactionId: string; status: string }> {
    const tx = await new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(tokenId), this.operatorId, -Number(amount))
      .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(toAccountId), Number(amount))
      .setTransactionMemo("refuel402 refund: sponsorship not delivered")
      .execute(this.client);
    const receipt = await tx.getReceipt(this.client);
    return { transactionId: tx.transactionId.toString(), status: receipt.status.toString() };
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
