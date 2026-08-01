import { randomUUID } from "node:crypto";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import {
  buildApproveCalldata,
  buildAssociateCalldata,
  buildExactOutputFuelCalldata,
  buildV1ExactOutputHbarCalldata,
  buildWrapCalldata,
} from "../../client/src/txbuilder.js";
import { NETWORKS } from "./config.js";
import type { ProductIntentBuilder } from "./product-lifecycle.js";
import {
  PRODUCT_AUTHORIZATION_MIN_RUNWAY_SEC,
  ProductLifecycleConflictError,
  type ProductIntentKind,
  type ProductJourneyRecord,
  type StoredProductQuote,
} from "./product-lifecycle-store.js";
import { bindSaucerRoute, saucerExecutionRoute } from "./route-binding.js";
import { productContractAddresses } from "./support.js";

function storedQuoteInvalid(message: string, details?: Record<string, unknown>): never {
  throw new ProductLifecycleConflictError("STORED_QUOTE_INVALID", message, details);
}

function record(value: unknown, field = "record"): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    storedQuoteInvalid(`stored quote ${field} is invalid`, { field });
  }
  return value as Record<string, any>;
}

function positiveInteger(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    storedQuoteInvalid(`stored quote ${field} is invalid`, { field });
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) storedQuoteInvalid(`stored quote ${field} must be positive`, { field });
  return parsed;
}

/**
 * Token base units to approve to Permit2: the canonical structured refuel cap,
 * or the x402 fee for a historical/manual quote that has no cap. Always
 * int64-representable, because HTS facades reject anything larger.
 */
function permit2ApprovalAmount(quote: Record<string, any>, x402: Record<string, any>): bigint {
  const fee = positiveInteger(x402.feeAmount, "x402.feeAmount");
  if (quote.refuelCap === undefined || quote.refuelCap === null) {
    if (fee > (1n << 63n) - 1n) {
      storedQuoteInvalid("permit2 approval amount is not representable as an HTS allowance", {
        field: "x402.feeAmount",
      });
    }
    return fee;
  }

  const capRecord = record(quote.refuelCap, "refuelCap");
  if (capRecord.schema !== "refuel402.refuel-cap.v1") {
    storedQuoteInvalid("stored quote refuelCap schema is invalid", { field: "refuelCap.schema" });
  }
  const cap = positiveInteger(capRecord.maxAmountIn, "refuelCap.maxAmountIn");
  const preauthorization = quote.refuelAuthorization === undefined || quote.refuelAuthorization === null
    ? null
    : record(quote.refuelAuthorization, "refuelAuthorization");
  if (preauthorization?.enabled === true) {
    const signedCap = positiveInteger(preauthorization.maxAmountIn, "refuelAuthorization.maxAmountIn");
    if (signedCap !== cap) {
      storedQuoteInvalid("stored quote refuel cap does not match its preauthorization terms", {
        field: "refuelAuthorization.maxAmountIn",
        refuelCapMaxAmountIn: cap.toString(),
        refuelAuthorizationMaxAmountIn: signedCap.toString(),
      });
    }
  }
  if (cap < fee) {
    storedQuoteInvalid("stored quote refuel cap is below the x402 service fee", {
      field: "refuelCap.maxAmountIn",
      refuelCapMaxAmountIn: cap.toString(),
      feeAmount: fee.toString(),
    });
  }
  if (cap > (1n << 63n) - 1n) {
    storedQuoteInvalid("permit2 approval amount is not representable as an HTS allowance", {
      field: "refuelCap.maxAmountIn",
    });
  }
  return cap;
}

/**
 * The mirror node and the JSON-RPC relay are different services with different
 * lag. `/activate` auto-creates a first-time wallet's Hedera account and waits
 * for the MIRROR to see it, then the very next call estimates gas against the
 * RELAY — which can still answer "Sender account not found" for several seconds.
 *
 * That is a propagation race on the happy path of every wallet that has never
 * touched Hedera, not an outage: the sponsor's HBAR is already spent and the
 * account already exists. Surfacing it verbatim told the owner "a Hedera network
 * read failed" and left the journey looking broken one step after it succeeded.
 */
const SENDER_NOT_PROPAGATED = /sender account not found/i;
const ASSOCIATION_NOT_PROPAGATED = /TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/i;
const SENDER_PROPAGATION_ATTEMPTS = 8;

/**
 * Two different relay-lag symptoms, one cause.
 *
 * `Sender account not found` follows a freshly auto-created account.
 * `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` follows a freshly submitted HTS association:
 * on an HTS-native asset the flow associates the token and then approves Permit2
 * on that same token, and the approve is estimated against a relay that has not
 * seen the association yet. Plain-ERC20 destinations never hit it, which is why
 * WETH worked and USDC.axl, QNT, WAVAX, WBNB and LINK.axl did not.
 *
 * Association is part of the flow, so by the time an approve is being built one
 * has always been submitted — "not associated" here is a timing artifact, never
 * a settled fact. Retried unconditionally for that reason: gating it on the
 * server having already recorded `intent_activation_confirmed` would fail fast
 * in exactly the case this exists to survive, the client reaching the approve
 * before the confirmation lands.
 */
function relayLagging(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SENDER_NOT_PROPAGATED.test(message) || ASSOCIATION_NOT_PROPAGATED.test(message);
}

async function awaitRelayPropagation<T>(
  operation: () => Promise<T>,
  wait: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= SENDER_PROPAGATION_ATTEMPTS || !relayLagging(error)) throw error;
      await wait(1_000);
    }
  }
}

export type UnsignedProductTransaction = {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: "0";
  gas: string;
  nonce: number;
  maxFeePerGas: "0";
  maxPriorityFeePerGas: "0";
};

/**
 * Builds only server-authoritative, quote-bound transactions. The browser signs
 * the returned fields; the policy RPC later consumes the matching authorization
 * atomically after recovering the actual raw transaction sender.
 */
export function createProductIntentBuilder(options: {
  loadQuote(journey: ProductJourneyRecord): Promise<StoredProductQuote | null>;
  nonce(mode: "testnet" | "mainnet", account: Address): Promise<number>;
  estimateGas(mode: "testnet" | "mainnet", transaction: Omit<UnsignedProductTransaction, "gas">): Promise<bigint>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): ProductIntentBuilder {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async build({ journey, intentKind, request }) {
      const stored = await options.loadQuote(journey);
      // Typed, because a quote aging out mid-journey is the ordinary end of a
      // short-lived price — not a defect. Untyped it became a 500 "this step
      // could not be prepared", a dead end offering nothing to do, on a journey
      // whose sponsored activation had already been paid for.
      if (!stored || stored.quoteId !== journey.quoteId) {
        throw new ProductLifecycleConflictError(
          "QUOTE_NOT_FOUND",
          "this quote is no longer available; get a fresh one to continue this transfer",
        );
      }
      if (!stored.executable) {
        throw new ProductLifecycleConflictError(
          "QUOTE_NOT_EXECUTABLE",
          "this quote can no longer be executed; get a fresh one to continue this transfer",
        );
      }
      const quote = record(stored.record);
      if (intentKind === "permit2_approval") {
        const requestedQuoteId = typeof request === "object" && request !== null && "quoteId" in request
          ? String((request as Record<string, unknown>).quoteId ?? "")
          : "";
        const effectiveQuoteId = String(quote.quoteId ?? "");
        if (!/^[0-9a-f]{64}$/.test(requestedQuoteId) || requestedQuoteId !== effectiveQuoteId) {
          throw new ProductLifecycleConflictError(
            "AUTHORIZATION_REPLAY",
            "destination consent is not bound to the current exact quote",
          );
        }
      }
      const asset = record(quote.asset);
      const destination = record(asset.destination);
      const destinationQuote = record(quote.destination);
      const amountLedger = record(quote.amountLedger);
      const destinationLedger = record(amountLedger.destination);
      const x402 = record(quote.x402);
      const legId = intentKind === "activation" ? "destination_activation" : intentKind;
      const executionLegs = Array.isArray(x402.executionLegs)
        ? x402.executionLegs.map((candidate: unknown) => record(candidate, "x402.executionLegs"))
        : [];
      const executionLeg = executionLegs.find((candidate) => candidate.id === legId);
      if (!executionLeg || executionLeg.payer !== "sponsor") {
        throw new Error("quote does not contain a sponsor allowance for the requested intent");
      }
      const quoteGasAllowanceTinybar = BigInt(String(executionLeg.gasAllowanceTinybar));
      const policyAllowanceCapTinybar = BigInt(process.env.PER_TX_ALLOWANCE_CAP_TINYBAR ?? 1_000_000_000n);
      if (quoteGasAllowanceTinybar <= 0n || quoteGasAllowanceTinybar > policyAllowanceCapTinybar) {
        throw new Error("quote-bound intent gas allowance exceeds product policy");
      }
      const network = NETWORKS[journey.mode];
      const contracts = productContractAddresses(journey.mode);
      const account = getAddress(journey.account);
      const rawDestinationToken = getAddress(String(destination.address));
      const wrapper = destination.wrapper ? record(destination.wrapper) : null;
      const tradeToken = wrapper ? getAddress(String(wrapper.htsAddress)) : rawDestinationToken;
      const paymentAssetInputMaximum = BigInt(String(destinationLedger.swapInputMaximum));
      const tradeInputMaximum = BigInt(String(destinationQuote.amountInMaximum ?? destinationLedger.swapInputMaximum));
      const exactHbarTinybar = BigInt(String(record(amountLedger.hbar).exactOutputTinybar));
      const routeBinding = String(destinationQuote.routeBinding ?? "");
      if (quote.routeMode !== "bridge_only" && (
        !/^[0-9a-f]{64}$/.test(routeBinding) || bindSaucerRoute(destinationQuote.saucerApiEvidence) !== routeBinding
      )) {
        throw new Error("stored Saucer route does not match its quote-bound execution evidence");
      }
      const route = quote.routeMode === "bridge_only"
        ? []
        : saucerExecutionRoute(destinationQuote.saucerApiEvidence).map((hop) => ({
            toToken: getAddress(hop.toToken),
            fee: hop.fee,
            venue: hop.venue,
          }));
      const routeVenue = route[0]?.venue ?? "v2";
      if (route.some((hop) => hop.venue !== routeVenue)) throw new Error("mixed-venue Saucer execution is unsupported");
      const swapRouter = routeVenue === "v1" ? network.v1Router : network.router;
      if (!swapRouter) throw new Error("Saucer V1 router is not configured");

      let to: Address;
      let data: Hex;
      switch (intentKind as ProductIntentKind) {
        case "activation":
          if (destination.standard !== "HTS" && !wrapper) throw new Error("ERC20 arrivals without a wrapper do not use the HTS association intent");
          to = wrapper ? getAddress(String(wrapper.htsAddress)) : rawDestinationToken;
          data = buildAssociateCalldata();
          break;
        case "permit2_approval":
          to = rawDestinationToken;
          // Sized for the whole refuel, not just the x402 fee. Permit2 pulls
          // `maxAmountIn` (fee + capped swap input), and the contract itself
          // requires serviceFeeAmount < maxAmountIn — so a fee-sized allowance can
          // never satisfy a pre-authorized execution and every attempt reverts.
          //
          // Bounded, NOT type(uint256).max. The usual Permit2 pattern is an
          // unbounded approval, but Hedera's HTS ERC-20 facade converts the amount
          // to HAPI's int64 allowance field and reverts above 2^63-1 — verified by
          // eth_estimateGas against a live mainnet HTS facade, where 2^63-1
          // succeeds and 2^63 reverts CONTRACT_REVERT_EXECUTED. An unbounded
          // approval would therefore have broken the MANUAL path too, on every
          // HTS-native asset, whether or not the pre-authorized refuel is enabled.
          data = buildApproveCalldata(contracts.permit2, permit2ApprovalAmount(quote, x402));
          break;
        case "wrapper_approval":
          if (!wrapper) throw new Error("selected destination asset has no wrapper");
          to = rawDestinationToken;
          data = buildApproveCalldata(getAddress(String(wrapper.address)), paymentAssetInputMaximum);
          break;
        case "wrapper_execution":
          if (!wrapper) throw new Error("selected destination asset has no wrapper");
          to = getAddress(String(wrapper.address));
          data = buildWrapCalldata(rawDestinationToken, account, paymentAssetInputMaximum);
          break;
        case "router_approval":
          to = tradeToken;
          data = buildApproveCalldata(swapRouter, tradeInputMaximum);
          break;
        case "router_execution":
          to = swapRouter;
          data = routeVenue === "v1"
            ? buildV1ExactOutputHbarCalldata({
                amountOut: exactHbarTinybar,
                amountInMaximum: tradeInputMaximum,
                path: [tradeToken, ...route.map((hop) => hop.toToken)],
                recipient: account,
                deadline: BigInt(stored.expiresAt),
              })
            : buildExactOutputFuelCalldata({
                ctx: { chainId: network.chainId, router: network.router, whbar: network.whbarToken, maxFeePerGas: 0n },
                inputToken: tradeToken,
                poolFee: route[0]?.fee ?? 0,
                route,
                amountOut: exactHbarTinybar,
                amountInMaximum: tradeInputMaximum,
                deadline: BigInt(stored.expiresAt),
                recipient: account,
              });
          break;
        default:
          throw new Error("unsupported product intent kind");
      }

      const nonce = await awaitRelayPropagation(() => options.nonce(journey.mode, account), wait);
      const base = {
        chainId: network.chainId,
        from: account,
        to,
        data,
        value: "0" as const,
        nonce,
        maxFeePerGas: "0" as const,
        maxPriorityFeePerGas: "0" as const,
      };
      const estimatedGas = await awaitRelayPropagation(() => options.estimateGas(journey.mode, base), wait);
      const policyMaximum = BigInt(process.env.PRODUCT_INTENT_GAS_LIMIT_MAX ?? 2_000_000n);
      if (estimatedGas <= 0n || estimatedGas > policyMaximum) throw new Error("intent gas estimate exceeds product policy");
      const gas = estimatedGas * 12n / 10n;
      if (gas > policyMaximum) throw new Error("intent gas headroom exceeds product policy");
      const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
      const authorizationTtl = Number(process.env.PRODUCT_AUTHORIZATION_TTL_SEC ?? 180);
      const expiresAt = Math.min(stored.expiresAt, nowSec + authorizationTtl);
      // The runway gate belongs to legs that TRADE at quoted prices. Destination
      // setup does not: `activation` associates a token, and `permit2_approval`
      // grants a bounded allowance the owner has already consented to — neither
      // moves value at the bridge's price, and the refuel witness re-binds the
      // real cap afterwards regardless.
      //
      // Enforcing it on setup made the pre-authorized flow unreachable for any
      // wallet new to Hedera. The bridge quote is the provider's own and lives
      // about a minute; funding plus association plus confirmation burns most of
      // it, so the approval that follows was refused for want of runway it could
      // never have had. Journey ced9d292: 26 seconds left against a 30-second
      // minimum, unsatisfiable the moment activation finished.
      const tradesAtQuotedPrice = intentKind !== "activation" && intentKind !== "permit2_approval";
      if (tradesAtQuotedPrice && expiresAt <= nowSec + PRODUCT_AUTHORIZATION_MIN_RUNWAY_SEC) {
        throw new ProductLifecycleConflictError(
          "QUOTE_EXPIRES_TOO_SOON",
          "quote expiry leaves insufficient authorization runway",
        );
      }
      const transaction: UnsignedProductTransaction = { ...base, gas: gas.toString() };
      return {
        authorization: {
          id: randomUUID(),
          mode: journey.mode,
          account,
          chainId: network.chainId,
          nonce,
          to,
          dataHash: keccak256(data),
          value: 0n,
          gasLimitMaximum: gas,
          maxGasAllowanceTinybar: quoteGasAllowanceTinybar,
          // A setup authorization is a short-lived permission to submit one
          // exact transaction, not a price commitment, so it gets its own runway
          // rather than inheriting a bridge quote that may already have aged out.
          // Clamping it to a stale quote produced an authorization born expired
          // and therefore unusable.
          expiresAt: tradesAtQuotedPrice ? expiresAt : nowSec + authorizationTtl,
        },
        transaction,
      };
    },
  };
}
