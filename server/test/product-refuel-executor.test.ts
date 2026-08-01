import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, parseAbiParameters, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createProductRefuelExecutor } from "../src/product-refuel-executor.js";
import { refuelRouteHash } from "../src/refuel-authorization-witness.js";
import type { RefuelAuthorizationRecord } from "../src/product-lifecycle-store.js";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const token = getAddress("0x2222222222222222222222222222222222222222");
const wrapper = getAddress("0x3333333333333333333333333333333333333333");
const htsToken = getAddress("0x4444444444444444444444444444444444444444");
const router = getAddress("0x5555555555555555555555555555555555555555");
const whbar = getAddress("0x6666666666666666666666666666666666666666");
const spender = getAddress("0x7777777777777777777777777777777777777777");
const route = {
  wrapper, htsToken, router, whbar, wrapperRate: "10",
  // V3 exact-output path: WHBAR out, 0.15% fee, HTS token in.
  swapPath: `0x${whbar.slice(2).toLowerCase()}0005dc${htsToken.slice(2).toLowerCase()}` as `0x${string}`,
};

function authorization(overrides: Partial<RefuelAuthorizationRecord> = {}): RefuelAuthorizationRecord {
  return {
    id: `0x${"ab".repeat(32)}`,
    journeyId: "journey-1",
    state: "executing",
    owner,
    token,
    maxAmountIn: "1000",
    exactHbarTinybar: "100000000",
    serviceFeeAmount: "100",
    maxSponsorExposureTinybar: "500000000",
    recipient: owner,
    journeyNonce: "9",
    deadline: 1_900_000_000,
    routeHash: refuelRouteHash({ ...route, wrapperRate: 10n }),
    signature: `0x${"11".repeat(65)}` as Hex,
    permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
    spender,
    route,
    attemptCount: 1,
    nextAttemptAt: 0,
    executionReference: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function quote(amountInMaximum = "10") {
  return {
    mode: "testnet",
    quoteId: "live-quote",
    destination: {
      amountInMaximum,
      saucerApiEvidence: {
        graphHash: "graph",
        selectedRoute: {
          routeId: "direct",
          venue: "v2",
          tokens: [htsToken, whbar],
          fees: [1500],
          amountIn: amountInMaximum,
          amountOutTinybar: "100000000",
          simulatedAt: "1",
          expiresAt: "2",
          hops: [{
            index: 0,
            venue: "v2",
            input: { address: htsToken },
            output: { address: whbar },
            pool: { id: "pool", contractId: "0.0.1" },
            feeTier: 1500,
          }],
        },
      },
    },
    amountLedger: { hbar: { exactOutputTinybar: "100000000" } },
  };
}

const eventAbi = parseAbi([
  "event RefuelExecuted(address indexed owner,bytes32 indexed journeyId,bytes32 indexed authorizationId,address token,uint256 spent,uint256 refunded,uint256 hbarDelivered,uint256 serviceFeeAmount,bytes32 routeHash)",
]);

function executionEvidence(auth = authorization()) {
  return {
    hash: `0x${"cd".repeat(32)}`,
    timestamp: "1.2",
    error_message: null,
    logs: [{
      topics: encodeEventTopics({
        abi: eventAbi,
        eventName: "RefuelExecuted",
        args: {
          owner,
          journeyId: `0x${BigInt(auth.journeyNonce).toString(16).padStart(64, "0")}` as Hex,
          authorizationId: auth.id as Hex,
        },
      }),
      data: encodeAbiParameters(
        parseAbiParameters("address,uint256,uint256,uint256,uint256,bytes32"),
        [token, 200n, 800n, 100_000_000n, 100n, auth.routeHash],
      ),
    }],
  };
}

function harness(input: { quote?: Record<string, unknown>; dispatch?: () => Promise<any>; evidence?: Record<string, any> | null } = {}) {
  const simulate = vi.fn(async () => undefined);
  const executeContractCall = vi.fn(input.dispatch ?? (async () => ({
    status: "SUCCESS",
    hederaTransactionId: "0.0.9@1.2",
    ethereumHash: `0x${"cd".repeat(32)}`,
    consensusTimestamp: "1.2",
    sponsorPaidTinybar: 123n,
    transfers: [],
  })));
  const executor = createProductRefuelExecutor({
    store: {} as any,
    sponsor: {
      operatorId: { toSolidityAddress: () => "9999999999999999999999999999999999999999" },
      executeContractCall,
    } as any,
    refreshDestinationQuote: async () => input.quote ?? quote(),
    simulate,
    readExecutionEvidence: async () => input.evidence === undefined ? executionEvidence() : input.evidence,
    now: () => 1_800_000_000_000,
  });
  return { executor, simulate, executeContractCall };
}

describe("pre-authorized product refuel executor", () => {
  it("re-quotes, simulates the exact proxy calldata, and completes one bounded sponsor call", async () => {
    const { executor, simulate, executeContractCall } = harness();
    await expect(executor.execute("journey-1", authorization())).resolves.toMatchObject({
      kind: "completed",
      executionReference: `0x${"cd".repeat(32)}`,
      evidence: { exactHbarTinybar: "100000000", signedCap: "1000", attemptMaximum: "200" },
    });
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(executeContractCall).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the live exact-output maximum exceeds the signed cap", async () => {
    const { executor, simulate, executeContractCall } = harness({ quote: quote("100") });
    await expect(executor.execute("journey-1", authorization())).resolves.toMatchObject({
      kind: "retry",
      errorCode: "REFUEL_CAP_PRICE_MISS",
    });
    expect(simulate).not.toHaveBeenCalled();
    expect(executeContractCall).not.toHaveBeenCalled();
  });

  it("keeps a successful HAPI receipt unknown until the contract event is authoritatively readable", async () => {
    const { executor } = harness({ evidence: null });
    await expect(executor.execute("journey-1", authorization())).resolves.toMatchObject({
      kind: "unknown",
      errorCode: "REFUEL_EXECUTION_READBACK_UNKNOWN",
    });
  });

  it("marks a claimed SDK dispatch unknown instead of retrying blindly", async () => {
    const { executor, executeContractCall } = harness({ dispatch: async () => { throw new Error("transport lost"); } });
    await expect(executor.execute("journey-1", authorization())).resolves.toMatchObject({
      kind: "unknown",
      errorCode: "REFUEL_EXECUTION_DISPATCH_UNKNOWN",
    });
    expect(executeContractCall).toHaveBeenCalledTimes(1);
  });
});
