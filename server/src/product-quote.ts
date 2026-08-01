import type express from "express";
import { z } from "zod";
import { getAddress } from "viem";
import { AmountInvariantError } from "./amount-domain.js";
import { BridgeAdapterError, quoteBridge as liveQuoteBridge, type BridgeQuote } from "./bridge.js";
import { composeBridgeOnlyQuote as liveComposeBridgeOnlyQuote } from "./bridge-only-quote.js";
import { buildCombinedQuote as liveBuildCombinedQuote, prewarmCombinedQuoteSaucerRoute, rankProviderQuotes } from "./combined-quote.js";
import { parseDecimalUnits } from "./planner.js";
import { RefuelCapError } from "./refuel-cap.js";
import { MirrorQuoteError, type Mirror } from "./mirror.js";
import {
  intersectSupport,
  loadSupportCatalog,
  probeRuntimeGates,
  type ProductAssetOption,
  type ProductMode,
  type RuntimeSupportGates,
  type SupportAsset,
  type SupportCatalog,
} from "./support.js";
import type { ProductLifecycleStore } from "./product-lifecycle-store.js";
import { hydrateSaucerSupportCatalog, SaucerApiError } from "./saucer-api.js";

export const ProductQuoteBody = z.object({
  mode: z.enum(["testnet", "mainnet"]),
  routeMode: z.enum(["bridge_only", "bridge_plus_refuel"]).default("bridge_plus_refuel"),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  provider: z.enum(["auto", "axelar", "layerzero"]),
  assetId: z.string().min(1).max(128),
  originChainId: z.string().regex(/^\d+$/),
  originToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amountBaseUnits: z.string().regex(/^[1-9]\d{0,77}$/),
  desiredHbar: z.string().regex(/^\d+(\.\d{1,8})?$/).optional().default("0"),
  slippageBps: z.number().int().min(1).max(300).default(100),
  refuelProtection: z.object({
    preset: z.enum(["flexible", "balanced", "strict", "custom"]).default("flexible"),
    customMaxAmountIn: z.string().regex(/^[1-9]\d{0,77}$/).optional(),
  }).default({ preset: "flexible" }),
  solveMaximumHbar: z.boolean().optional().default(false),
}).superRefine((value, context) => {
  if (value.routeMode === "bridge_plus_refuel" && value.desiredHbar === "0") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["desiredHbar"], message: "desired HBAR is required for bridge + refuel" });
  }
  if (value.refuelProtection.preset === "custom" && !value.refuelProtection.customMaxAmountIn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refuelProtection", "customMaxAmountIn"], message: "custom price protection requires an exact cap" });
  }
  if (value.refuelProtection.preset !== "custom" && value.refuelProtection.customMaxAmountIn) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refuelProtection", "customMaxAmountIn"], message: "custom cap is valid only with the custom preset" });
  }
});

type RefuelCombinedQuote = Awaited<ReturnType<typeof liveBuildCombinedQuote>>;
export type ProductCombinedQuote =
  | (Omit<RefuelCombinedQuote, "timing"> & { timing?: RefuelCombinedQuote["timing"] })
  | Awaited<ReturnType<typeof liveComposeBridgeOnlyQuote>>;

function failure(res: express.Response, status: number, code: string, message: string, retriable: boolean, details?: unknown) {
  return res.status(status).json({ code, error: code, message, retriable, ...(details ? { details } : {}) });
}

export function createProductQuoteHandler(options: {
  mirrors: Record<ProductMode, Mirror>;
  lifecycleStore?: Pick<ProductLifecycleStore, "saveQuote"> | null;
  runtimeGates?: (mode: ProductMode, mirror: Mirror) => Promise<RuntimeSupportGates>;
  bridgeQuote?: (input: Parameters<typeof liveQuoteBridge>[0]) => Promise<BridgeQuote>;
  combinedQuote?: (input: Parameters<typeof liveBuildCombinedQuote>[0]) => Promise<ProductCombinedQuote>;
  bridgeOnlyQuote?: (input: Parameters<typeof liveComposeBridgeOnlyQuote>[0]) => Awaited<ReturnType<typeof liveComposeBridgeOnlyQuote>>;
  catalog?: (mode: ProductMode) => SupportCatalog;
  saucerCatalog?: (catalog: SupportCatalog) => Promise<SupportCatalog>;
}) {
  const runtimeGates = options.runtimeGates ?? probeRuntimeGates;
  const bridgeQuote = options.bridgeQuote ?? liveQuoteBridge;
  const combinedQuote = options.combinedQuote ?? liveBuildCombinedQuote;
  const bridgeOnlyQuote = options.bridgeOnlyQuote ?? liveComposeBridgeOnlyQuote;
  return async (req: express.Request, res: express.Response) => {
    const requestStartedAt = Date.now();
    // Parsed before the try so the catch-all can name which request failed. It
    // is a pure schema decode with its own 400; nothing here can throw.
    const parsed = ProductQuoteBody.safeParse(req.body);
    if (!parsed.success) return failure(res, 400, "BAD_REQUEST", "invalid combined quote request", false, parsed.error.issues);
    const data = parsed.data;
    try {
      const staticCatalog = (options.catalog ?? loadSupportCatalog)(data.mode);
      const catalogStartedAt = Date.now();
      let catalogAndGraphMs = 0;
      const catalogPromise = Promise.resolve(data.routeMode === "bridge_only"
        ? staticCatalog
        : options.saucerCatalog
          ? options.saucerCatalog(staticCatalog)
          : process.env.SAUCERSWAP_API_KEY
            ? hydrateSaucerSupportCatalog(staticCatalog)
            : staticCatalog).then((value) => {
              catalogAndGraphMs = Date.now() - catalogStartedAt;
              return value;
            });
      const runtimeGatesStartedAt = Date.now();
      let runtimeGatesMs = 0;
      const runtimeGatesPromise = runtimeGates(data.mode, options.mirrors[data.mode]).then((value) => {
        runtimeGatesMs = Date.now() - runtimeGatesStartedAt;
        return value;
      });
      const [catalog, gates] = await Promise.all([catalogPromise, runtimeGatesPromise]);
      const selectedAsset = catalog.assets.find((asset) => asset.id === data.assetId);
      if (!selectedAsset || !selectedAsset.originNetworks.includes(data.originChainId)) {
        return failure(res, 400, "PRODUCT_ASSET_UNSUPPORTED", "asset is not available from the selected origin network", false);
      }
      if (data.provider !== "auto" && selectedAsset.provider !== data.provider) {
        return failure(res, 400, "PROVIDER_ASSET_MISMATCH", "asset does not belong to the explicitly selected provider", false);
      }
      const selectedOriginToken = selectedAsset.originTokens?.find(
        (candidate) => candidate.chainId === data.originChainId && candidate.address.toLowerCase() === data.originToken.toLowerCase(),
      );
      if (!selectedOriginToken) {
        return failure(res, 400, "ORIGIN_TOKEN_UNVERIFIED", "origin token is not in the current provider support catalog", false);
      }
      const desiredHbarTinybar = data.routeMode === "bridge_only"
        ? 0n
        : parseDecimalUnits(data.desiredHbar, 8);
      const maxRefuelTinybar = BigInt(process.env.MAX_REFUEL_TINYBAR ?? 5_000_000_000n);
      if (data.routeMode === "bridge_plus_refuel" && desiredHbarTinybar <= 0n) {
        return failure(res, 400, "REFUEL_AMOUNT_OUT_OF_RANGE", "desired HBAR must be greater than zero for bridge + refuel", false);
      }
      if (data.routeMode === "bridge_plus_refuel" && desiredHbarTinybar > maxRefuelTinybar) {
        return failure(
          res,
          422,
          "DESIRED_HBAR_EXCEEDS_MAXIMUM",
          "desired HBAR exceeds the configured server maximum",
          false,
          {
            desiredTinybar: desiredHbarTinybar.toString(),
            maximumTinybar: maxRefuelTinybar.toString(),
            limitingConstraint: "CONFIGURED_MAX_HBAR",
            solverResolutionTinybar: "0",
          },
        );
      }

      // No shipped catalog defines a comparisonGroup yet, so Auto currently
      // collapses to the selected asset; the ranking below activates unchanged
      // once a multi-provider comparison pair lands in a catalog.
      const comparisonGroup = selectedAsset.comparisonGroup ?? selectedAsset.id;
      const candidates = data.provider === "auto"
        ? catalog.assets.filter((candidate) =>
            (candidate.comparisonGroup ?? candidate.id) === comparisonGroup &&
            candidate.symbol === selectedAsset.symbol &&
            candidate.originNetworks.includes(data.originChainId) &&
            candidate.originTokens?.some(
              (origin) => origin.chainId === data.originChainId && origin.address.toLowerCase() === data.originToken.toLowerCase(),
            ),
          )
        : [selectedAsset];
      const eligible = candidates
        .map((asset) => ({ asset, runtimeAsset: intersectSupport(asset, gates, data.routeMode) }))
        .filter(({ runtimeAsset }) => runtimeAsset.runtime.quoteReady);
      if (eligible.length === 0) {
        return res.status(409).json({
          code: data.provider === "auto" ? "AUTO_PROVIDER_NO_QUOTE_READY_ROUTE" : "PRODUCT_QUOTE_NOT_READY",
          message: "the selected provider scope has no current quote-ready destination route",
          providerSelection: { requested: data.provider, comparisonGroup },
          candidates: candidates.map((asset) => intersectSupport(asset, gates, data.routeMode)),
          retriable: true,
        });
      }

      const account = getAddress(data.account);
      const attempts = await Promise.allSettled(eligible.map(async ({ asset, runtimeAsset }: { asset: SupportAsset; runtimeAsset: ProductAssetOption }) => {
        const originToken = asset.originTokens!.find(
          (candidate) => candidate.chainId === data.originChainId && candidate.address.toLowerCase() === data.originToken.toLowerCase(),
        )!;
        // The Saucer leg needs no bridge data: pre-warming it here lets the
        // serialized exact-output simulations overlap the provider request;
        // buildCombinedQuote coalesces onto the same inflight simulation. Only
        // the live pipeline pre-warms — injected test doubles must not trigger
        // real simulations. Error semantics are unchanged: a bridge failure
        // rejects this attempt as BridgeAdapterError before the combined quote
        // runs, and a Saucer failure surfaces from the authoritative call.
        if (data.routeMode === "bridge_plus_refuel" && !options.combinedQuote) {
          prewarmCombinedQuoteSaucerRoute({
            mode: data.mode,
            asset,
            desiredHbarTinybar,
            mirror: options.mirrors[data.mode],
          });
        }
        const bridge = await bridgeQuote({
          mode: data.mode,
          provider: asset.provider,
          originChainId: data.originChainId,
          originToken: getAddress(originToken.address),
          amount: BigInt(data.amountBaseUnits),
          account,
          asset,
          slippageBps: data.slippageBps,
        });
        if (data.routeMode === "bridge_only") {
          return bridgeOnlyQuote({
            mode: data.mode,
            requestedProvider: data.provider,
            supportEvidenceAt: catalog.evidenceAt,
            account,
            asset,
            runtimeAsset,
            bridge,
          });
        }
        return combinedQuote({
          mode: data.mode,
          requestedProvider: data.provider,
          supportEvidenceAt: catalog.evidenceAt,
          account,
          asset,
          runtimeAsset,
          bridge,
          desiredHbarTinybar,
          slippageBps: data.slippageBps,
          refuelProtection: {
            preset: data.refuelProtection.preset,
            customMaxAmountIn: data.refuelProtection.customMaxAmountIn
              ? BigInt(data.refuelProtection.customMaxAmountIn)
              : null,
          },
          mirror: options.mirrors[data.mode],
          solveMaximumHbar: data.solveMaximumHbar,
        });
      }));
      const quotes = attempts
        .filter((attempt): attempt is PromiseFulfilledResult<ProductCombinedQuote> => attempt.status === "fulfilled")
        .map((attempt) => attempt.value);
      if (quotes.length === 0) {
        const firstError = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult | undefined;
        throw firstError?.reason ?? new BridgeAdapterError("PROVIDER_ROUTE_UNAVAILABLE", "no provider returned a usable quote");
      }
      let selected: ProductCombinedQuote;
      if (data.routeMode === "bridge_only") {
        const fresh = quotes.filter((candidate) => !candidate.blockers.includes("STALE_QUOTE"));
        if (fresh.length === 0) return failure(res, 503, "STALE_QUOTE", "bridge quote expired", true);
        selected = rankProviderQuotes(fresh)[0]!;
      } else {
        const withinMaximum = quotes.filter((candidate) =>
          candidate.feasibility.desiredAssessment?.feasible &&
          BigInt(candidate.feasibility.maximumTinybar) >= desiredHbarTinybar,
        );
        const affordable = withinMaximum.filter((candidate) => !candidate.blockers.includes("STALE_QUOTE"));
        if (affordable.length === 0 && withinMaximum.length > 0) {
          return failure(res, 503, "STALE_QUOTE", "authoritative quote evidence expired during bounded maximum evaluation", true);
        }
        if (affordable.length === 0) {
          const bestMaximum = quotes.reduce((best, candidate) =>
            BigInt(candidate.feasibility.maximumTinybar) > BigInt(best.feasibility.maximumTinybar) ? candidate : best,
          );
          const desiredExceedsMaximum = desiredHbarTinybar > BigInt(bestMaximum.feasibility.maximumTinybar);
          return failure(
            res,
            422,
            desiredExceedsMaximum ? "DESIRED_HBAR_EXCEEDS_MAXIMUM" : "DESIRED_HBAR_ROUTE_INFEASIBLE",
            desiredExceedsMaximum
              ? "desired HBAR exceeds the server-verified maximum for the selected route and origin amount"
              : "the exact desired HBAR output is not feasible on the current fresh route",
            false,
            {
              desiredTinybar: desiredHbarTinybar.toString(),
              maximumTinybar: bestMaximum.feasibility.maximumTinybar,
              limitingConstraint: bestMaximum.feasibility.limitingConstraint,
              solverResolutionTinybar: bestMaximum.feasibility.resolutionTinybar,
              providers: quotes.map((candidate) => ({
                provider: candidate.bridge.provider,
                maximumTinybar: candidate.feasibility.maximumTinybar,
                limitingConstraint: candidate.feasibility.limitingConstraint,
                desiredAssessment: candidate.feasibility.desiredAssessment,
              })),
            },
          );
        }
        selected = rankProviderQuotes(affordable)[0]!;
      }
      const candidateTiming = "timing" in selected && selected.timing && typeof selected.timing === "object"
        ? selected.timing
        : {};
      const quoteTiming: Record<string, unknown> = {
        schema: "refuel402.quote-timing.v1",
        catalogAndGraphMs,
        runtimeGatesMs,
        providerQuoteMs: selected.bridge.timing?.providerRequestMs ?? 0,
        providerTransactionConstructionMs: selected.bridge.timing?.transactionConstructionMs ?? 0,
        externalProviderMs: selected.bridge.timing?.totalMs ?? 0,
        ...candidateTiming,
        maximumSolverRequested: data.solveMaximumHbar,
      };
      const quote = {
        ...selected,
        routeMode: data.routeMode,
        providerSelection: {
          ...selected.providerSelection,
          compared: quotes.map((candidate) => candidate.bridge.provider),
        },
        assetSelection: {
          requestedAssetId: selectedAsset.id,
          selectedAssetId: selected.asset.id,
          assetPreserved: selected.asset.id === selectedAsset.id || selected.asset.symbol === selectedAsset.symbol,
        },
        timing: quoteTiming,
      };
      const lifecycleSaveStartedAt = Date.now();
      await options.lifecycleStore?.saveQuote({
        quoteId: quote.quoteId,
        mode: quote.mode,
        account: quote.account,
        requestedProvider: quote.providerSelection.requested,
        selectedProvider: quote.providerSelection.selected,
        assetId: quote.asset.id,
        originChainId: quote.bridge.originChainId,
        expiresAt: quote.expiresAt,
        executable: quote.capabilities.execute,
        record: quote as unknown as Record<string, unknown>,
      });
      quoteTiming.lifecycleSaveMs = Date.now() - lifecycleSaveStartedAt;
      quoteTiming.totalRequestMs = Date.now() - requestStartedAt;
      // Serialize exactly once and send the string; res.json would stringify a
      // second time. Serialization cost/size are measurable only afterwards, so
      // they travel as headers instead of body fields.
      const serializationStartedAt = Date.now();
      const body = JSON.stringify(quote);
      res.set("x-quote-serialization-ms", String(Date.now() - serializationStartedAt));
      res.set("x-quote-bytes", String(Buffer.byteLength(body)));
      return res.set("content-type", "application/json; charset=utf-8").send(body);
    } catch (error) {
      if (error instanceof AmountInvariantError) {
        // A hard data inconsistency is not transient; retrying cannot fix it.
        return failure(res, 502, "QUOTE_DATA_INCONSISTENT", error.message, false, { code: error.code });
      }
      if (error instanceof SaucerApiError) {
        const userRouteError = ["ROUTE_UNAVAILABLE", "MIXED_VENUE_EXECUTION_UNSUPPORTED", "STALE_QUOTE"].includes(error.code);
        return failure(res, userRouteError ? 422 : 503, error.code, error.message, error.code === "REQUEST_FAILED");
      }
      if (error instanceof MirrorQuoteError) {
        return failure(res, 503, error.code, error.message, false);
      }
      if (error instanceof BridgeAdapterError) {
        const userRouteError = ["PROVIDER_ROUTE_UNAVAILABLE", "PROVIDER_UNSUPPORTED_TOKEN_NETWORK", "STALE_QUOTE"].includes(error.code);
        // A paused provider is retriable and is emphatically not the owner's
        // fault, so it keeps 503 while carrying its own actionable message.
        return failure(res, userRouteError ? 422 : 503, error.code, error.message, !userRouteError);
      }
      // The owner's own cap, not an outage: 422 and never retriable, because
      // retrying the identical request is guaranteed to fail the same way.
      if (error instanceof RefuelCapError) {
        return failure(res, 422, error.code, error.message, false, error.details);
      }
      // The catch-all used to swallow the exception entirely, so a real defect
      // reached the owner as "temporarily unavailable" and left NOTHING in the
      // logs to bind it to. Anything landing here is unclassified by definition
      // and must be legible before it is reported as transient.
      console.error("[product-quote] unclassified quote failure", {
        requestId: res.locals.requestId ?? null,
        mode: data.mode,
        assetId: data.assetId,
        routeMode: data.routeMode,
        refuelProtectionPreset: data.refuelProtection?.preset ?? null,
        name: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null,
      });
      return failure(res, 503, "COMBINED_QUOTE_UNAVAILABLE", "combined quote is temporarily unavailable", true);
    }
  };
}
