import { Buffer } from "node:buffer";
import { encodeFunctionData, getAddress, hashTypedData, keccak256, verifyTypedData, type Address, type Hex } from "viem";
import { bridgeAdoptionTypedData } from "./bridge-adoption-witness.js";
import { bridgeTransferStatus, type BridgeTransferStatus } from "./bridge.js";
import type { Mirror, MirrorTokenCredit } from "./mirror.js";
import {
  ProductLifecycleConflictError,
  type ProductJourneyRecord,
  type ProductLifecycleStore,
  type StoredProductQuote,
} from "./product-lifecycle-store.js";

const ADOPTION_WINDOW_NANOS = 72n * 3_600n * 1_000_000_000n;
// Extra credit-index pages adoption may anchor to identify ledger credits that
// fall past the first page; exhausting it is undetermined, never "no credit".
const ADOPTION_CREDIT_PAGE_BUDGET = 8;

export type MirrorTokenTransferDelta = { consensusTimestamp: string; amount: bigint };

/** The bounded ledger walk ran out of pages, so no answer is authoritative. */
export class MirrorLedgerDepthError extends Error {}

/**
 * Signed token-transfer deltas for account+token at/after a consensus
 * timestamp, so a pre-credit balance can be replayed from the ledger instead of
 * trusted from the current (deposit-polluted) balance. The optional upper bound
 * keeps a windowed scan from paging through everything since the boundary.
 */
export async function mirrorTokenTransfersSince(
  mirror: Mirror,
  accountId: string,
  tokenId: string,
  consensusTimestamp: string,
  untilConsensusTimestamp?: string,
): Promise<MirrorTokenTransferDelta[]> {
  const deltas: MirrorTokenTransferDelta[] = [];
  const until = untilConsensusTimestamp ? `&timestamp=lte:${untilConsensusTimestamp}` : "";
  let url = `${mirror.mirrorBase}/api/v1/transactions?account.id=${accountId}&timestamp=gte:${consensusTimestamp}${until}&order=asc&limit=100`;
  for (let page = 0; page < 10; page += 1) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`mirror token-transfer history -> ${response.status}`);
    const body = await response.json() as {
      transactions?: Array<{
        consensus_timestamp?: string;
        result?: string;
        token_transfers?: Array<{ account?: string; amount?: number | string; token_id?: string }>;
      }>;
      links?: { next?: string | null };
    };
    for (const transaction of body.transactions ?? []) {
      if (transaction.result !== "SUCCESS") continue;
      for (const transfer of transaction.token_transfers ?? []) {
        if (transfer.account !== accountId || transfer.token_id !== tokenId) continue;
        deltas.push({
          consensusTimestamp: String(transaction.consensus_timestamp ?? ""),
          amount: BigInt(transfer.amount ?? 0),
        });
      }
    }
    if (!body.links?.next) return deltas;
    url = `${mirror.mirrorBase}${body.links.next}`;
  }
  throw new MirrorLedgerDepthError("mirror token-transfer history is too deep to replay a ledger baseline");
}

const balanceOfAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("stored quote record is invalid");
  return value as Record<string, any>;
}

function millisecondsToConsensusTimestamp(value: number): string {
  const seconds = Math.floor(value / 1_000);
  const nanos = String(value % 1_000).padStart(3, "0").padEnd(9, "0");
  return `${seconds}.${nanos}`;
}

function consensusNanos(value: string): bigint {
  const [secondsRaw, nanosRaw] = value.split(".");
  const seconds = secondsRaw ?? "";
  const nanos = nanosRaw ?? "";
  if (!/^\d+$/.test(seconds) || !/^\d{1,9}$/.test(nanos)) throw new Error("consensus timestamp is invalid");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0"));
}

function consensusTimestamp(nanos: bigint): string {
  if (nanos < 0n) throw new Error("consensus timestamp is invalid");
  return `${nanos / 1_000_000_000n}.${String(nanos % 1_000_000_000n).padStart(9, "0")}`;
}

function mirrorTransactionHash(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("mirror transaction hash is invalid");
  }
  return `0x${bytes.toString("hex")}`;
}

export async function readProductDestinationBalance(input: {
  quote: StoredProductQuote;
  account: Address;
  mirror: Mirror;
}): Promise<bigint> {
  const quoteRecord = record(input.quote.record);
  const asset = record(quoteRecord.asset);
  const destination = record(asset.destination);
  if (destination.standard === "HTS") {
    if (typeof destination.tokenId !== "string") throw new Error("HTS destination token id is missing");
    const result = await input.mirror.account(input.account);
    const token = result?.balance.tokens?.find((candidate) => candidate.token_id === destination.tokenId);
    return BigInt(token?.balance ?? 0);
  }
  const token = getAddress(String(destination.address));
  const data = encodeFunctionData({ abi: balanceOfAbi, functionName: "balanceOf", args: [input.account] });
  return BigInt(await input.mirror.ethCall(token, data, input.account));
}

function bridgeSubmission(journey: ProductJourneyRecord): {
  sourceTransactionHash: Hex;
  destinationBalanceBefore: string;
  hbarBalanceBefore: string;
  submittedAt: number;
} | null {
  const event = [...journey.events].reverse().find((candidate) => candidate.type === "bridge_submitted");
  if (!event) return null;
  const hash = String(event.record.sourceTransactionHash ?? "");
  const balance = String(event.record.destinationBalanceBefore ?? "");
  const hbar = String(event.record.hbarBalanceBefore ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || !/^\d+$/.test(balance) || !/^\d+$/.test(hbar)) {
    throw new Error("stored bridge submission is invalid");
  }
  return {
    sourceTransactionHash: hash as Hex,
    destinationBalanceBefore: balance,
    hbarBalanceBefore: hbar,
    submittedAt: event.createdAt,
  };
}

function amountCriterion(amount: bigint, expected: bigint, minimum: bigint): "exact" | "minimum" | null {
  if (expected <= 0n && minimum <= 0n) return null;
  if (expected > 0n && amount === expected) return "exact";
  if (minimum > 0n && amount >= minimum) return "minimum";
  return null;
}

function sameAddress(left: unknown, right: Address): boolean {
  try {
    return getAddress(String(left)) === right;
  } catch {
    return false;
  }
}

export function createProductBridgeTracker(options: {
  store: ProductLifecycleStore;
  mirrors: Record<"testnet" | "mainnet", Mirror>;
  transferStatus?: typeof bridgeTransferStatus;
  tokenTransfersSince?: typeof mirrorTokenTransfersSince;
}) {
  async function quoteAndJourney(journeyId: string): Promise<{ journey: ProductJourneyRecord; quote: StoredProductQuote }> {
    const journey = await options.store.getJourney(journeyId);
    if (!journey) throw new Error("journey does not exist");
    const quote = await options.store.getQuote(journey.quoteId);
    if (!quote) throw new Error("journey quote does not exist");
    return { journey, quote };
  }

  return {
    async submit(journeyId: string, sourceTransactionHash: Hex) {
      const { journey, quote } = await quoteAndJourney(journeyId);
      const mirror = options.mirrors[quote.mode];
      const [before, accountState] = await Promise.all([
        readProductDestinationBalance({ quote, account: journey.account, mirror }),
        mirror.account(journey.account),
      ]);
      if (!accountState) throw new Error("destination account is not activated before bridge submission");
      return options.store.recordBridgeSubmission({
        journeyId,
        sourceTransactionHash,
        destinationBalanceBefore: before.toString(),
        hbarBalanceBefore: String(accountState.balance.balance),
      });
    },

    async adopt(journeyId: string, sourceTransactionHash: Hex, confirmation: Hex): Promise<ProductJourneyRecord> {
      const { journey, quote } = await quoteAndJourney(journeyId);
      // Owner consent gates every branch below: a journey id alone must never be
      // enough to bind a provider-known source hash to somebody else's journey.
      const consent = bridgeAdoptionTypedData({
        journeyId: journey.id,
        account: journey.account,
        sourceTransactionHash,
        mode: quote.mode,
      });
      const consented = await verifyTypedData({ ...consent, address: journey.account, signature: confirmation })
        .catch(() => false);
      if (!consented) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "bridge adoption consent does not recover to the journey account for this journey, hash and network",
        );
      }
      const adopted = journey.events.find((event) => event.type === "bridge_submission_adopted");
      if (adopted && String(adopted.record.sourceTransactionHash).toLowerCase() === sourceTransactionHash.toLowerCase()) {
        return journey;
      }
      if (journey.events.some((event) => event.type === "bridge_submitted")) {
        throw new ProductLifecycleConflictError(
          adopted ? "IDEMPOTENCY_CONFLICT" : "JOURNEY_STATE_CONFLICT",
          adopted
            ? "a different source transaction hash was already adopted"
            : "a bridge submission hash is already durable; poll GET /v1/product/journeys/:id/bridge instead",
        );
      }
      if (!["ready", "bridge_ready"].includes(journey.state)) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", `bridge adoption cannot run from ${journey.state}`);
      }
      const boundary = journey.events.find((event) => event.type === "bridge_wallet_boundary");
      if (!boundary) {
        throw new ProductLifecycleConflictError("JOURNEY_STATE_CONFLICT", "no bridge wallet boundary was ever recorded for this journey");
      }
      const quoteRecord = record(quote.record);
      const bridge = record(quoteRecord.bridge);
      const destination = record(record(quoteRecord.asset).destination);
      if (typeof bridge.quoteId !== "string" || !bridge.quoteId) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "stored provider quote id is missing");
      }
      const expectedTokenId = destination.standard === "HTS" && typeof destination.tokenId === "string"
        ? destination.tokenId
        : null;
      if (!expectedTokenId) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "bridge adoption requires an HTS destination token for credit matching");
      }
      const expectedAmount = BigInt(String(bridge.expectedDestinationAmount ?? 0));
      const minimumExpected = BigInt(String(bridge.minimumDestinationAmount ?? 0));
      if (expectedAmount <= 0n && minimumExpected <= 0n) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "stored quote has no expected destination amounts");
      }
      let providerTransfer: BridgeTransferStatus;
      try {
        providerTransfer = await (options.transferStatus ?? bridgeTransferStatus)({
          mode: quote.mode,
          provider: journey.selectedProvider,
          quoteId: bridge.quoteId,
          sourceTransactionHash,
          originChainId: journey.originChainId,
        });
      } catch {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "provider observation is unavailable for this route; adoption requires a provider-confirmed status",
        );
      }
      if (providerTransfer.state === "failed" || providerTransfer.state === "unknown") {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          `provider reports ${providerTransfer.state} (${providerTransfer.providerStatus}) for the submitted hash`,
        );
      }
      const mirror = options.mirrors[quote.mode];
      const accountState = await mirror.account(journey.account);
      if (!accountState) throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "destination account is unavailable during bridge adoption");
      const boundaryFrom = millisecondsToConsensusTimestamp(boundary.createdAt);
      const boundaryNanos = consensusNanos(boundaryFrom);
      const windowEndNanos = boundaryNanos + ADOPTION_WINDOW_NANOS;
      const transfersSince = options.tokenTransfersSince ?? mirrorTokenTransfersSince;
      // mirror.tokenCreditsAfter reads a single page, so on a busy account the
      // matching credit can sit past the page boundary and a one-page read would
      // report NO_MATCHING_CREDIT for a credit that exists. The signed ledger for
      // the window is the completeness oracle: every matching credit it shows has
      // to be identified in the credit index before any answer is definitive.
      let ledger: MirrorTokenTransferDelta[];
      try {
        ledger = await transfersSince(
          mirror,
          accountState.account,
          expectedTokenId,
          boundaryFrom,
          consensusTimestamp(windowEndNanos),
        );
      } catch (error) {
        if (!(error instanceof MirrorLedgerDepthError)) throw error;
        throw new ProductLifecycleConflictError(
          "AMBIGUOUS_CREDIT",
          "the destination ledger for the adoption window exceeds the bounded page budget; adoption is undetermined",
        );
      }
      const [firstPage, bound] = await Promise.all([
        mirror.tokenCreditsAfter({
          accountId: accountState.account,
          tokenId: expectedTokenId,
          consensusTimestamp: boundaryFrom,
          limit: 100,
        }),
        options.store.boundArrivalTransactionIds(journey.account),
      ]);
      const position = (entry: { consensusTimestamp: string; amount: bigint }) => `${entry.consensusTimestamp}:${entry.amount}`;
      const credits = new Map<string, MirrorTokenCredit>();
      const identified = new Set<string>();
      const collect = (page: MirrorTokenCredit[]) => {
        for (const credit of page) {
          if (credit.accountId !== accountState.account || credit.tokenId !== expectedTokenId) continue;
          const nanos = consensusNanos(credit.consensusTimestamp);
          if (nanos <= boundaryNanos || nanos > windowEndNanos) continue;
          credits.set(`${credit.transactionId}:${position(credit)}`, credit);
          identified.add(position(credit));
        }
      };
      collect(firstPage);
      const ledgerMatches = ledger.filter((delta) =>
        delta.amount > 0n &&
        amountCriterion(delta.amount, expectedAmount, minimumExpected) !== null &&
        consensusNanos(delta.consensusTimestamp) > boundaryNanos &&
        consensusNanos(delta.consensusTimestamp) <= windowEndNanos);
      let anchoredPages = 0;
      for (const delta of ledgerMatches) {
        if (identified.has(position(delta))) continue;
        if (anchoredPages >= ADOPTION_CREDIT_PAGE_BUDGET) {
          throw new ProductLifecycleConflictError(
            "AMBIGUOUS_CREDIT",
            "matching destination credits outrun the bounded credit-page budget; adoption is undetermined",
          );
        }
        anchoredPages += 1;
        // Re-anchor one nanosecond before the ledger credit so its own transaction
        // heads the page, which is the only way to recover its transaction id.
        collect(await mirror.tokenCreditsAfter({
          accountId: accountState.account,
          tokenId: expectedTokenId,
          consensusTimestamp: consensusTimestamp(consensusNanos(delta.consensusTimestamp) - 1n),
          limit: 25,
        }));
        if (!identified.has(position(delta))) {
          throw new ProductLifecycleConflictError(
            "AMBIGUOUS_CREDIT",
            "the destination ledger shows a matching credit the credit index cannot identify; adoption is undetermined",
          );
        }
      }
      const candidates = [...credits.values()].filter((credit) =>
        amountCriterion(credit.amount, expectedAmount, minimumExpected) !== null &&
        !bound.has(credit.transactionId));
      if (candidates.length === 0) {
        throw new ProductLifecycleConflictError(
          "NO_MATCHING_CREDIT",
          "no unbound destination credit matches the stored quote inside the adoption window",
        );
      }
      if (candidates.length > 1) {
        throw new ProductLifecycleConflictError(
          "AMBIGUOUS_CREDIT",
          `multiple unbound credits match the stored quote; never auto-picking among consensus timestamps ${candidates.map((credit) => credit.consensusTimestamp).join(", ")}`,
        );
      }
      const credit = candidates[0]!;
      const creditTransactionHash = mirrorTransactionHash(credit.transactionHash);
      if (
        providerTransfer.destinationTransactionHash &&
        providerTransfer.destinationTransactionHash.toLowerCase() !== creditTransactionHash.toLowerCase()
      ) {
        throw new ProductLifecycleConflictError(
          "EVIDENCE_CONFLICT",
          "provider destination hash does not match the matched credit transaction",
        );
      }
      const currentBalance = BigInt(
        accountState.balance.tokens?.find((token) => token.token_id === expectedTokenId)?.balance ?? 0,
      );
      const deltas = await transfersSince(mirror, accountState.account, expectedTokenId, credit.consensusTimestamp);
      const netSinceCredit = deltas.reduce((sum, delta) => sum + delta.amount, 0n);
      const destinationBalanceBefore = currentBalance - netSinceCredit;
      if (destinationBalanceBefore < 0n) {
        throw new ProductLifecycleConflictError("EVIDENCE_CONFLICT", "ledger replay produced a negative pre-credit balance");
      }
      return options.store.adoptBridgeSubmission({
        journeyId,
        sourceTransactionHash,
        destinationBalanceBefore: destinationBalanceBefore.toString(),
        hbarBalanceBefore: String(accountState.balance.balance),
        credit: {
          transactionId: credit.transactionId,
          transactionHash: creditTransactionHash,
          consensusTimestamp: credit.consensusTimestamp,
          tokenId: credit.tokenId,
          accountId: credit.accountId,
          amount: credit.amount.toString(),
        },
        amountCriterion: amountCriterion(credit.amount, expectedAmount, minimumExpected),
        provider: providerTransfer.provider,
        providerState: providerTransfer.state,
        providerStatus: providerTransfer.providerStatus,
        evidence: {
          providerUrl: providerTransfer.providerUrl,
          providerObservedAt: providerTransfer.observedAt,
          boundaryConsensusFrom: boundaryFrom,
          candidateCount: candidates.length,
          // The consent artifact itself, not a server-set boolean: anyone can
          // re-verify the digest against the journey account from the event log.
          consentDigest: hashTypedData(consent),
          consentSignature: confirmation,
          consentSignatureHash: keccak256(confirmation),
          ledgerMatchCount: ledgerMatches.length,
          anchoredCreditPages: anchoredPages,
        },
      });
    },

    async status(journeyId: string): Promise<{
      transfer: BridgeTransferStatus;
      arrival: {
        confirmed: boolean;
        chainAuthoritative: boolean;
        providerLagging: boolean;
        balanceBefore: string;
        balanceAfter: string;
        amountReceived: string;
        expectedAmount: string;
        minimumExpected: string;
        expectedRecipient: Address;
        expectedTokenId: string | null;
        destinationTransactionId: string | null;
        destinationTransactionHash: string | null;
        consensusTimestamp: string | null;
        submittedAfter: string;
        amountCriterion: "exact" | "minimum" | null;
        candidateCount: number;
      };
      journey: ProductJourneyRecord;
    }> {
      const { journey, quote } = await quoteAndJourney(journeyId);
      const submission = bridgeSubmission(journey);
      if (!submission) throw new Error("bridge submission does not exist");
      const quoteRecord = record(quote.record);
      const bridge = record(quoteRecord.bridge);
      const asset = record(quoteRecord.asset);
      const destination = record(asset.destination);
      if (typeof bridge.quoteId !== "string" || !bridge.quoteId) throw new Error("stored provider quote id is missing");
      let providerTransfer: BridgeTransferStatus;
      try {
        providerTransfer = await (options.transferStatus ?? bridgeTransferStatus)({
          mode: quote.mode,
          provider: journey.selectedProvider,
          quoteId: bridge.quoteId,
          sourceTransactionHash: submission.sourceTransactionHash,
          originChainId: journey.originChainId,
        });
      } catch {
        providerTransfer = {
          provider: journey.selectedProvider,
          state: "pending",
          sourceTransactionHash: submission.sourceTransactionHash,
          destinationTransactionHash: null,
          providerStatus: "provider_observation_unavailable",
          providerUrl: null,
          observedAt: new Date().toISOString(),
        };
      }
      const mirror = options.mirrors[quote.mode];
      const [after, accountState] = await Promise.all([
        readProductDestinationBalance({ quote, account: journey.account, mirror }),
        mirror.account(journey.account),
      ]);
      if (!accountState) throw new Error("destination account is unavailable during bridge reconciliation");
      const before = BigInt(submission.destinationBalanceBefore);
      const received = after > before ? after - before : 0n;
      const expectedAmount = BigInt(String(bridge.expectedDestinationAmount ?? 0));
      const minimumExpected = BigInt(String(bridge.minimumDestinationAmount ?? 0));
      const submittedAfter = millisecondsToConsensusTimestamp(submission.submittedAt);
      const expectedTokenId = destination.standard === "HTS" && typeof destination.tokenId === "string"
        ? destination.tokenId
        : null;
      const credits = expectedTokenId
        ? await mirror.tokenCreditsAfter({
          accountId: accountState.account,
          tokenId: expectedTokenId,
          consensusTimestamp: submittedAfter,
        })
        : [];
      // Both bounds matter. `received` is a balance DELTA against a baseline frozen
      // at submission, so the longer this journey sits pending the less that delta
      // describes this transfer — any later credit of the same size starts to look
      // like an arrival. With only a lower bound this was tolerable while a live
      // browser was the sole trigger; the sweeper now runs it unattended and
      // oldest-first, forever, which turns "eventually a coincidence" into a
      // false arrival that terminalizes the journey. adopt() already bounds its
      // matching by the same window (see ADOPTION_WINDOW_NANOS at the top).
      const submittedNanos = consensusNanos(submittedAfter);
      const windowEndNanos = submittedNanos + ADOPTION_WINDOW_NANOS;
      const matching = credits.filter((credit) =>
        credit.accountId === accountState.account &&
        credit.tokenId === expectedTokenId &&
        credit.amount === received &&
        consensusNanos(credit.consensusTimestamp) > submittedNanos &&
        consensusNanos(credit.consensusTimestamp) <= windowEndNanos &&
        amountCriterion(credit.amount, expectedAmount, minimumExpected) !== null
      );
      const credit = matching.length === 1 ? matching[0] : null;
      const matchedCriterion = credit ? amountCriterion(credit.amount, expectedAmount, minimumExpected) : null;
      const expectedRecipientMatches =
        sameAddress(bridge.fromAddress, journey.account) &&
        sameAddress(bridge.toAddress, journey.account) &&
        sameAddress(accountState.evm_address, journey.account);
      const expectedTokenMatches =
        expectedTokenId !== null &&
        bridge.normalized?.destinationAsset?.tokenId === expectedTokenId;
      const routeIdentityMatches =
        bridge.provider === journey.selectedProvider &&
        providerTransfer.provider === journey.selectedProvider &&
        providerTransfer.sourceTransactionHash.toLowerCase() === submission.sourceTransactionHash.toLowerCase() &&
        typeof bridge.normalized?.evidence?.source === "string" &&
        typeof bridge.normalized?.evidence?.responseHash === "string";
      const chainAuthoritative = Boolean(
        expectedTokenId &&
        credit &&
        expectedRecipientMatches &&
        expectedTokenMatches &&
        routeIdentityMatches &&
        received > 0n &&
        matchedCriterion,
      );
      const providerLagging = chainAuthoritative && providerTransfer.state !== "arrived";
      const providerConfirmed = !expectedTokenId && providerTransfer.state === "arrived" && received >= minimumExpected;
      const confirmed = chainAuthoritative || providerConfirmed;
      const chainTransactionHash = credit ? mirrorTransactionHash(credit.transactionHash) : null;
      let current = journey;
      if (confirmed && journey.state === "bridge_pending") {
        current = await options.store.recordBridgeArrival({
          journeyId,
          sourceTransactionHash: submission.sourceTransactionHash,
          destinationTransactionId: credit?.transactionId ?? null,
          destinationTransactionHash: chainTransactionHash ?? providerTransfer.destinationTransactionHash,
          providerDestinationTransactionHash: providerTransfer.destinationTransactionHash,
          destinationBalanceBefore: before.toString(),
          destinationBalanceAfter: after.toString(),
          destinationAmountReceived: received.toString(),
          expectedRecipient: journey.account,
          expectedTokenId,
          expectedDestinationAmount: expectedAmount.toString(),
          minimumDestinationAmount: minimumExpected.toString(),
          amountCriterion: matchedCriterion ?? (providerConfirmed ? "minimum" : null),
          consensusTimestamp: credit?.consensusTimestamp ?? null,
          bridgeSubmittedAt: submittedAfter,
          provider: providerTransfer.provider,
          providerState: providerTransfer.state,
          providerStatus: providerTransfer.providerStatus,
          providerLagging,
          routeIdentity: {
            quoteId: bridge.quoteId,
            originChainId: journey.originChainId,
            evidenceSource: bridge.normalized?.evidence?.source ?? null,
            routeId: bridge.normalized?.evidence?.routeId ?? null,
            responseHash: bridge.normalized?.evidence?.responseHash ?? null,
          },
        });
      }
      if (confirmed && quoteRecord.routeMode === "bridge_only" && current.state === "arrival_confirmed") {
        current = await options.store.completeBridgeOnly(journeyId);
      }
      const transfer: BridgeTransferStatus = confirmed
        ? {
          ...providerTransfer,
          state: "arrived",
          destinationTransactionHash: providerTransfer.destinationTransactionHash,
        }
        : providerTransfer.state === "arrived"
          ? { ...providerTransfer, state: "pending", providerStatus: "arrival_indexing" }
          : providerTransfer;
      return {
        transfer,
        arrival: {
          confirmed,
          chainAuthoritative,
          providerLagging,
          balanceBefore: before.toString(),
          balanceAfter: after.toString(),
          amountReceived: received.toString(),
          expectedAmount: expectedAmount.toString(),
          minimumExpected: minimumExpected.toString(),
          expectedRecipient: journey.account,
          expectedTokenId,
          destinationTransactionId: credit?.transactionId ?? null,
          destinationTransactionHash: chainTransactionHash ?? providerTransfer.destinationTransactionHash,
          consensusTimestamp: credit?.consensusTimestamp ?? null,
          submittedAfter,
          amountCriterion: matchedCriterion ?? (providerConfirmed ? "minimum" : null),
          candidateCount: matching.length,
        },
        journey: current,
      };
    },
  };
}
