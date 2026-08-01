import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import { encodeExactOutputPath } from "../../client/src/txbuilder.js";
import type { SponsorClient } from "./hedera.js";
import { refuelRouteHash } from "./refuel-authorization-witness.js";
import { saucerExecutionRoute } from "./route-binding.js";
import type { ProductLifecycleStore, RefuelAuthorizationRecord } from "./product-lifecycle-store.js";

const executeRefuelAbi = parseAbi([
  "function executeRefuel((address owner,address token,uint256 maxAmountIn,uint256 exactHbarTinybar,uint256 serviceFeeAmount,address recipient,uint256 journeyNonce,uint256 deadline,bytes32 routeHash) authorization,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address wrapper,address htsToken,address router,address whbar,uint256 wrapperRate,bytes swapPath) route,uint256 wrapAmount,uint256 tradeAmountInMaximum,bytes signature) returns (bytes32 id)",
  "event RefuelExecuted(address indexed owner,bytes32 indexed journeyId,bytes32 indexed authorizationId,address token,uint256 spent,uint256 refunded,uint256 hbarDelivered,uint256 serviceFeeAmount,bytes32 routeHash)",
]);

export type RefuelExecutionOutcome =
  | { kind: "completed"; executionReference: string; evidence: Record<string, unknown> }
  | { kind: "retry"; errorCode: string; evidence: Record<string, unknown> }
  | { kind: "fallback"; errorCode: string; evidence: Record<string, unknown> }
  | { kind: "unknown"; errorCode: string; executionReference: string | null; evidence: Record<string, unknown> };

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("refuel execution quote is invalid");
  return value as Record<string, any>;
}

export function authorizationCalldata(authorization: RefuelAuthorizationRecord, tradeAmountInMaximum: bigint): Hex {
  const route = authorization.route;
  const wrapAmount = tradeAmountInMaximum * BigInt(route.wrapperRate);
  return encodeFunctionData({
    abi: executeRefuelAbi,
    functionName: "executeRefuel",
    args: [
      {
        owner: authorization.owner,
        token: authorization.token,
        maxAmountIn: BigInt(authorization.maxAmountIn),
        exactHbarTinybar: BigInt(authorization.exactHbarTinybar),
        serviceFeeAmount: BigInt(authorization.serviceFeeAmount),
        recipient: authorization.recipient,
        journeyNonce: BigInt(authorization.journeyNonce),
        deadline: BigInt(authorization.deadline),
        routeHash: authorization.routeHash,
      },
      {
        permitted: { token: authorization.token, amount: BigInt(authorization.maxAmountIn) },
        nonce: BigInt(authorization.journeyNonce),
        deadline: BigInt(authorization.deadline),
      },
      {
        wrapper: route.wrapper,
        htsToken: route.htsToken,
        router: route.router,
        whbar: route.whbar,
        wrapperRate: BigInt(route.wrapperRate),
        swapPath: route.swapPath,
      },
      wrapAmount,
      tradeAmountInMaximum,
      authorization.signature,
    ],
  });
}

/**
 * Re-quotes before dispatch, checks the signed cap and route, simulates the exact
 * calldata, then submits one bounded sponsor-owned contract call. No retry occurs
 * inside this executor: the durable sweeper owns the schedule and failure budget.
 */
export function createProductRefuelExecutor(options: {
  store: ProductLifecycleStore;
  sponsor: SponsorClient;
  sponsorMode?: "testnet" | "mainnet";
  refreshDestinationQuote(journeyId: string): Promise<Record<string, unknown>>;
  simulate(mode: "testnet" | "mainnet", from: string, to: string, data: Hex): Promise<void>;
  authorizeSponsorExposure?(authorization: RefuelAuthorizationRecord): Promise<void>;
  readExecutionEvidence(mode: "testnet" | "mainnet", transactionId: string): Promise<Record<string, any> | null>;
  now?: () => number;
}) {
  return {
    async execute(journeyId: string, authorization: RefuelAuthorizationRecord): Promise<RefuelExecutionOutcome> {
      const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1_000);
      if (authorization.deadline <= nowSec) {
        return { kind: "fallback", errorCode: "REFUEL_AUTHORIZATION_EXPIRED", evidence: { deadline: authorization.deadline } };
      }
      let refreshed: Record<string, any>;
      try {
        refreshed = record(await options.refreshDestinationQuote(journeyId));
      } catch (error) {
        return {
          kind: "retry",
          errorCode: "REFUEL_DESTINATION_REQUOTE_UNAVAILABLE",
          evidence: { message: error instanceof Error ? error.message : String(error) },
        };
      }
      const quote = record(refreshed.quote ?? refreshed.record ?? refreshed);
      try {
        if (options.sponsorMode && quote.mode !== options.sponsorMode) {
          throw new Error("journey mode does not match the configured sponsor network");
        }
        const destination = record(quote.destination);
        const amountLedger = record(quote.amountLedger);
        const route = saucerExecutionRoute(destination.saucerApiEvidence);
        // Any hop count; every hop must be a V3-style pool because the contract
        // calls exactOutput. The live route is re-encoded and hashed below, so a
        // route that moved since signing fails the routeHash comparison rather
        // than executing against terms the owner never saw.
        if (route.length < 1 || route.some((hop) => hop.venue !== "v2")) {
          throw new Error("atomic refuel requires an all-V2 exact-output route");
        }
        const liveRouteHash = refuelRouteHash({
          wrapper: authorization.route.wrapper,
          htsToken: authorization.route.htsToken,
          router: authorization.route.router,
          whbar: authorization.route.whbar,
          wrapperRate: BigInt(authorization.route.wrapperRate),
          swapPath: encodeExactOutputPath(
            [getAddress(authorization.route.htsToken), ...route.map((hop) => getAddress(hop.toToken))],
            route.map((hop) => hop.fee),
          ),
        });
        if (
          liveRouteHash.toLowerCase() !== authorization.routeHash.toLowerCase() ||
          getAddress(route[route.length - 1]!.toToken) !== getAddress(authorization.route.whbar) ||
          BigInt(record(amountLedger.hbar).exactOutputTinybar) !== BigInt(authorization.exactHbarTinybar)
        ) {
          return { kind: "fallback", errorCode: "REFUEL_ROUTE_AUTHORITY_MISMATCH", evidence: { liveRouteHash } };
        }
        const tradeAmountInMaximum = BigInt(String(destination.amountInMaximum));
        const wrapAmount = tradeAmountInMaximum * BigInt(authorization.route.wrapperRate);
        const totalMaximum = wrapAmount + BigInt(authorization.serviceFeeAmount);
        if (totalMaximum > BigInt(authorization.maxAmountIn)) {
          return {
            kind: "retry",
            errorCode: "REFUEL_CAP_PRICE_MISS",
            evidence: {
              attemptMaximum: totalMaximum.toString(),
              signedCap: authorization.maxAmountIn,
              liveQuoteId: String(quote.quoteId ?? ""),
            },
          };
        }
        const data = authorizationCalldata(authorization, tradeAmountInMaximum);
        try {
          const sponsorSolidity = options.sponsor.operatorId.toSolidityAddress();
          const sponsorAddress = getAddress(sponsorSolidity.startsWith("0x") ? sponsorSolidity : `0x${sponsorSolidity}`);
          await options.simulate(quote.mode, sponsorAddress, authorization.spender, data);
        } catch (error) {
          return {
            kind: "retry",
            errorCode: "REFUEL_SIMULATION_PRICE_OR_CAP_MISS",
            evidence: { message: error instanceof Error ? error.message : String(error), liveQuoteId: String(quote.quoteId ?? "") },
          };
        }
        try {
          await options.authorizeSponsorExposure?.(authorization);
        } catch (error) {
          return {
            kind: "retry",
            errorCode: "REFUEL_SPONSOR_EXPOSURE_UNAVAILABLE",
            evidence: { message: error instanceof Error ? error.message : String(error) },
          };
        }
        // The observed mainnet execution used 3,265,146 of a 3,500,000 limit —
        // 6.7% headroom — before the leftover unwrap was added to the refund path.
        // Hedera bills gas USED, so a higher ceiling costs nothing when unspent;
        // running out mid-refuel, after the swap has filled, costs a retry.
        const gas = BigInt(process.env.REFUEL_EXECUTION_GAS_LIMIT ?? 3_800_000n);
        const configuredFeeCap = BigInt(process.env.REFUEL_EXECUTION_MAX_FEE_TINYBAR ?? 1_500_000_000n);
        const authorizationFeeCap = BigInt(authorization.maxSponsorExposureTinybar);
        const maxTransactionFeeTinybar = configuredFeeCap < authorizationFeeCap ? configuredFeeCap : authorizationFeeCap;
        try {
          const submission = await options.sponsor.executeContractCall({
            contract: authorization.spender,
            calldata: data,
            gas,
            maxTransactionFeeTinybar,
            memo: `Refuel402 preauthorized ${journeyId}`,
          });
          const evidence: Record<string, any> = {
            status: submission.status,
            hederaTransactionId: submission.hederaTransactionId,
            ethereumHash: submission.ethereumHash,
            consensusTimestamp: submission.consensusTimestamp,
            sponsorPaidTinybar: submission.sponsorPaidTinybar.toString(),
            liveQuoteId: String(quote.quoteId ?? ""),
            attemptMaximum: totalMaximum.toString(),
            signedCap: authorization.maxAmountIn,
            exactHbarTinybar: authorization.exactHbarTinybar,
          };
          if (submission.status !== "SUCCESS") {
            return { kind: "fallback", errorCode: "REFUEL_EXECUTION_REVERTED", evidence };
          }
          let authoritative: Record<string, any> | null;
          try {
            authoritative = await options.readExecutionEvidence(quote.mode, submission.hederaTransactionId);
          } catch (error) {
            authoritative = null;
            evidence.readbackError = error instanceof Error ? error.message : String(error);
          }
          if (!authoritative || authoritative.error_message !== null || !Array.isArray(authoritative.logs)) {
            return {
              kind: "unknown",
              errorCode: "REFUEL_EXECUTION_READBACK_UNKNOWN",
              executionReference: submission.hederaTransactionId,
              evidence,
            };
          }
          const event = authoritative.logs.map((log: any): any => {
            try { return decodeEventLog({ abi: executeRefuelAbi, data: log.data, topics: log.topics }); } catch { return null; }
          }).find((candidate: any) => candidate?.eventName === "RefuelExecuted")?.args as Record<string, any> | undefined;
          if (
            !event ||
            getAddress(String(event.owner)) !== authorization.owner ||
            String(event.authorizationId).toLowerCase() !== authorization.id.toLowerCase() ||
            String(event.routeHash).toLowerCase() !== authorization.routeHash.toLowerCase() ||
            BigInt(event.hbarDelivered) !== BigInt(authorization.exactHbarTinybar) ||
            BigInt(event.serviceFeeAmount) !== BigInt(authorization.serviceFeeAmount) ||
            BigInt(event.spent) + BigInt(event.refunded) !== BigInt(authorization.maxAmountIn)
          ) {
            return {
              kind: "unknown",
              errorCode: "REFUEL_EXECUTION_EVENT_MISMATCH",
              executionReference: String(authoritative.hash ?? submission.hederaTransactionId),
              evidence: { ...evidence, authoritative },
            };
          }
          return {
            kind: "completed",
            executionReference: String(authoritative.hash ?? submission.hederaTransactionId),
            evidence: {
              ...evidence,
              contractResultHash: authoritative.hash,
              consensusTimestamp: authoritative.timestamp ?? evidence.consensusTimestamp,
              event: Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value])),
            },
          };
        } catch (error) {
          // Dispatch was claimed before entering the SDK call. A transport error
          // cannot prove absence, so the one-shot authorization stays unknown and
          // is never blindly retried.
          return {
            kind: "unknown",
            errorCode: "REFUEL_EXECUTION_DISPATCH_UNKNOWN",
            executionReference: null,
            evidence: { message: error instanceof Error ? error.message : String(error) },
          };
        }
      } catch (error) {
        return {
          kind: "fallback",
          errorCode: "REFUEL_EXECUTION_CONTRACT_MISMATCH",
          evidence: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  };
}
