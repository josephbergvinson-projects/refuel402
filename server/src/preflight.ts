// Live-chain checks, run TWICE per sponsorship (security review F5):
//   - at quote time: balance must cover amountIn + fee, nonce fresh, route viable
//   - immediately before submission (post-settlement): everything re-checked
//     against fresh state, because the fee debit and pool moves invalidate the
//     original simulation by construction.
// Read-only in all cases.
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi, quoterAbi } from "./abi.js";
import { encodeExactOutputPath, encodeSwapPath } from "../../client/src/txbuilder.js";
import type { Mirror } from "./mirror.js";
import type { BundleSummary, DecodedTx } from "./types.js";
import { TESTNET, tokenRoute } from "./config.js";

export type PreflightResult = {
  ok: boolean;
  failures: { code: string; message: string }[];
  /** Swap quote (WHBAR output), null for swap-less bundles. */
  expectedOut: bigint | null;
  /** Expected token input; exact-output paths compare this to the immutable maximum. */
  expectedAmountIn: bigint | null;
  quoterGasEstimate: bigint | null;
  /** Expected gas per leg, aligned with summary.legs order */
  perLegGas: bigint[];
  /** total gas units we realistically expect the bundle to consume */
  expectedGasUnits: bigint;
};

/** HTS system-contract overhead not captured by the quoter's EVM-only estimate. */
const SWAP_HTS_OVERHEAD = 550_000n;
/** associate()/approve() on an HTS facade measured ~785k gas. */
const HTS_OP_GAS = 785_000n;

export async function preflightBundle(
  mirror: Mirror,
  decoded: DecodedTx[],
  summary: BundleSummary,
  opts: {
    /** extra input-token units the account must hold beyond amountIn (the fee at quote time; 0n at re-sim) */
    requiredExtraBalance: bigint;
    /** Separate experimental kill gate only; ordinary execution fails closed on hollow accounts. */
    allowHollow?: boolean;
  },
): Promise<PreflightResult> {
  const failures: { code: string; message: string }[] = [];
  const sender = summary.sender;

  // 1. Nonce freshness: first tx of the bundle must match the account's live nonce.
  const account = await mirror.account(sender);
  if (!account) {
    failures.push({
      code: "ACCOUNT_MISSING",
      message: `no Hedera account exists yet for ${sender}; receive HBAR or an HTS token at the alias first`,
    });
  } else {
    if (!account.key && !opts.allowHollow) {
      failures.push({
        code: "ACCOUNT_HOLLOW",
        message: `${sender} is a hollow account; the separate sponsored-completion kill gate has not been enabled`,
      });
    } else if (account.key && account.key._type !== "ECDSA_SECP256K1") {
      failures.push({
        code: "ACCOUNT_NOT_ECDSA",
        message: `${sender} is complete but does not expose an ECDSA_SECP256K1 key`,
      });
    }
    const liveNonce = account.ethereum_nonce ?? 0;
    const firstNonce = decoded[0]!.nonce;
    if (firstNonce !== liveNonce) {
      failures.push({
        code: "STALE_NONCE",
        message: `bundle starts at nonce ${firstNonce} but account nonce is ${liveNonce}`,
      });
    }
  }

  // 2. Associate legs: reject if the account is ALREADY associated with the
  // target token — the associate() would revert and waste ~1 HBAR of sponsor
  // gas. The client should drop the leg and renumber nonces.
  for (const leg of summary.legs) {
    if (leg.kind !== "associate" || !leg.token) continue;
    const already = await mirror.isAssociated(sender, leg.token.tokenId);
    if (already === true) {
      failures.push({
        code: "ASSOCIATE_REDUNDANT",
        message: `${sender} is already associated with ${leg.token.symbol} (${leg.token.tokenId}); drop the associate leg`,
      });
    } else if (already === null) {
      // Fail CLOSED: if we can't confirm the account is NOT already associated,
      // don't sponsor an associate that may revert and burn ~1 HBAR of gas.
      failures.push({
        code: "ASSOCIATION_UNVERIFIABLE",
        message: `could not verify association status for ${leg.token.symbol} (mirror error) — retry shortly`,
      });
    }
  }

  // 3. Swap leg (if present): balance for amountIn(+fee) and QuoterV2 route/price.
  let expectedOut: bigint | null = null;
  let expectedAmountIn: bigint | null = null;
  let quoterGasEstimate: bigint | null = null;
  if (summary.hasSwap && summary.swapInputToken) {
    const inputToken = summary.swapInputToken;
    try {
      const res = await mirror.ethCall(
        inputToken.evmAddress,
        encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [sender] }),
      );
      const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: res }) as bigint;
      const required = summary.amountIn + opts.requiredExtraBalance;
      if (balance < required) {
        failures.push({
          code: "INSUFFICIENT_BALANCE",
          message: `balance ${balance} ${inputToken.symbol} is below required ${required} (amountIn + fee)`,
        });
      }
    } catch (e) {
      failures.push({ code: "BALANCE_CHECK_FAILED", message: "token balance could not be verified" });
    }

    try {
      const route = tokenRoute(inputToken, TESTNET.whbarToken);
      const tokens = [inputToken.evmAddress, ...route.map((h) => h.toToken)];
      const fees = route.map((h) => h.fee);
      if (summary.swapMode === "exactOutput") {
        const path = encodeExactOutputPath(tokens, fees);
        const quoted = await mirror.quoteExactOutput(TESTNET.quoter, path, summary.amountOutMinimum);
        expectedOut = summary.amountOutMinimum;
        expectedAmountIn = quoted.amountIn;
        quoterGasEstimate = quoted.gasEstimate;
        if (quoted.amountIn > summary.amountIn) {
          failures.push({
            code: "MAX_IN_EXCEEDED",
            message: `current exact-output quote needs ${quoted.amountIn}, above immutable maximum ${summary.amountIn}`,
          });
        }
      } else {
        const path = encodeSwapPath(tokens, fees);
        const res = await mirror.ethCall(
          TESTNET.quoter,
          encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [path, summary.amountIn] }),
        );
        const [amountOut, , , gasEstimate] = decodeFunctionResult({
          abi: quoterAbi,
          functionName: "quoteExactInput",
          data: res,
        }) as readonly [bigint, readonly bigint[], readonly number[], bigint];
        expectedOut = amountOut;
        expectedAmountIn = summary.amountIn;
        quoterGasEstimate = gasEstimate;
        if (amountOut < summary.quotedMinOut) {
          failures.push({
            code: "MIN_OUT_UNREACHABLE",
            message: `current quote ${amountOut} is below the bundle's amountOutMinimum ${summary.quotedMinOut}; refresh the quote`,
          });
        }
        if (summary.quotedMinOut * 2n < amountOut) {
          failures.push({
            code: "DUSTY_MIN_OUT",
            message: `amountOutMinimum ${summary.quotedMinOut} is under 50% of the current quote ${amountOut}; tighten slippage`,
          });
        }
      }
    } catch (e) {
      failures.push({ code: "NO_ROUTE", message: "QuoterV2 could not price the vetted route" });
    }

    if (!summary.approve) {
      try {
        const allowanceRaw = await mirror.ethCall(
          inputToken.evmAddress,
          encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [sender, TESTNET.router] }),
        );
        const allowance = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceRaw }) as bigint;
        if (allowance < summary.amountIn) {
          failures.push({
            code: "ALLOWANCE_LOW",
            message: `Router allowance ${allowance} is below required maximum ${summary.amountIn}; add an exact approval leg`,
          });
        }
      } catch (e) {
        failures.push({ code: "ALLOWANCE_CHECK_FAILED", message: "Router allowance could not be verified" });
      }
    }

    const swapLeg = summary.legs.find((l) => l.kind === "swap");
    if (quoterGasEstimate !== null && swapLeg && swapLeg.gasLimit < quoterGasEstimate) {
      failures.push({
        code: "GAS_LIMIT_LOW",
        message: `swap gasLimit ${swapLeg.gasLimit} is below quoter estimate ${quoterGasEstimate}`,
      });
    }
  }

  // 4. Per-leg gas expectation (aligned with summary.legs order).
  const perLegGas = summary.legs.map((leg) =>
    leg.kind === "swap" ? (quoterGasEstimate ?? 200_000n) + SWAP_HTS_OVERHEAD : HTS_OP_GAS,
  );
  const expectedGasUnits = perLegGas.reduce((a, g) => a + g, 0n);

  return {
    ok: failures.length === 0,
    failures,
    expectedOut,
    expectedAmountIn,
    quoterGasEstimate,
    perLegGas,
    expectedGasUnits,
  };
}

/** Kept for API completeness; the full re-sim (preflightBundle with
 * requiredExtraBalance 0n) is what the server actually uses post-settlement.
 * Returns "unknown" on RPC error so the caller fails CLOSED on the pre-payment
 * affordability gate (a transient mirror error must not let an underfunded
 * bundle through — the sponsor would eat gas on the inevitable revert). */
export async function recheckBalance(
  mirror: Mirror,
  token: Address,
  sender: Address,
  needed: bigint,
): Promise<"ok" | "short" | "unknown"> {
  try {
    const res = await mirror.ethCall(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [sender] }),
    );
    const bal = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: res }) as bigint;
    return bal >= needed ? "ok" : "short";
  } catch {
    return "unknown";
  }
}
