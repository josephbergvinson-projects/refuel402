import { NETWORKS } from "./config.js";
import type { SaucerApiEvidence } from "./saucer-api.js";
import type { ProductMode, SupportAsset } from "./support.js";

const HOLLOW_ACTIVATION_EXPECTED_GAS = 785_000n;
const HTS_APPROVAL_EXPECTED_GAS = 785_000n;
const ERC20_APPROVAL_EXPECTED_GAS = 120_000n;
const WRAP_EXPECTED_GAS = 700_000n;
const X402_SETTLEMENT_EXPECTED_GAS = 400_000n;
const SWAP_HTS_OVERHEAD = 550_000n;

export type ProductExecutionLegPlan = {
  id: string;
  label: string;
  stage: "destination_activation" | "x402" | "wrapper" | "saucer" | "policy";
  payer: "sponsor" | "facilitator";
  expectedGas: bigint;
};

export function productExecutionLegPlan(asset: SupportAsset, swapGasEstimate: bigint): ProductExecutionLegPlan[] {
  return [
    ...(asset.destination.arrival === "activation_required"
      ? [{
          id: "destination_activation",
          label: "Destination account activation / HTS association",
          stage: "destination_activation" as const,
          payer: "sponsor" as const,
          expectedGas: HOLLOW_ACTIVATION_EXPECTED_GAS,
        }]
      : []),
    {
      id: "permit2_approval",
      label: "Destination Permit2 token approval",
      stage: "x402" as const,
      payer: "sponsor" as const,
      expectedGas: asset.destination.standard === "HTS" ? HTS_APPROVAL_EXPECTED_GAS : ERC20_APPROVAL_EXPECTED_GAS,
    },
    {
      id: "x402_settlement",
      label: "x402 Permit2/proxy settlement",
      stage: "x402" as const,
      payer: "facilitator" as const,
      expectedGas: X402_SETTLEMENT_EXPECTED_GAS,
    },
    ...(asset.destination.wrapper
      ? [
          { id: "wrapper_approval", label: "Wrapper token approval", stage: "wrapper" as const, payer: "sponsor" as const, expectedGas: ERC20_APPROVAL_EXPECTED_GAS },
          { id: "wrapper_execution", label: "ERC20 → HTS wrapper execution", stage: "wrapper" as const, payer: "sponsor" as const, expectedGas: WRAP_EXPECTED_GAS },
          { id: "router_approval", label: "Saucer HTS Router approval", stage: "saucer" as const, payer: "sponsor" as const, expectedGas: HTS_APPROVAL_EXPECTED_GAS },
        ]
      : [{ id: "router_approval", label: "Saucer Router approval", stage: "saucer" as const, payer: "sponsor" as const, expectedGas: HTS_APPROVAL_EXPECTED_GAS }]),
    {
      id: "router_execution",
      label: "Saucer exact-output swap and WHBAR unwrap",
      stage: "saucer" as const,
      payer: "sponsor" as const,
      expectedGas: swapGasEstimate + SWAP_HTS_OVERHEAD,
    },
  ];
}

export function buildRoutePresentation(
  mode: ProductMode,
  asset: SupportAsset,
  evidence: SaucerApiEvidence | null | undefined,
) {
  const selected = evidence?.selectedRoute;
  if (!selected) return null;
  const feeLabel = (feeTier: number) => `${(feeTier / 10_000).toFixed(2)}%`;
  const whbar = NETWORKS[mode].whbarToken.toLowerCase();
  const hops = selected.hops.map((hop) => ({
    ...hop,
    venue: hop.venue ?? selected.venue ?? "v2",
    version: hop.venue ?? selected.venue ?? "v2",
    input: hop.input.address.toLowerCase() === whbar
      ? { ...hop.input, reportedSymbol: hop.input.symbol, symbol: "WHBAR" }
      : hop.input,
    output: hop.output.address.toLowerCase() === whbar
      ? { ...hop.output, reportedSymbol: hop.output.symbol, symbol: "WHBAR" }
      : hop.output,
  }));
  const firstSymbol = hops[0]?.input.symbol ?? asset.symbol;
  const parts = [`${asset.symbol} (${asset.provider === "layerzero" && asset.destination.standard === "ERC20" ? "OFT ERC20" : asset.destination.standard})`];
  if (asset.destination.wrapper) parts.push(`${firstSymbol ?? `HTS-${asset.symbol}`} [wrapper]`);
  for (const hop of hops) {
    parts.push(`${hop.output.symbol ?? hop.output.tokenId} [Saucer ${hop.venue.toUpperCase()} ${feeLabel(hop.feeTier)}]`);
  }
  if (hops.at(-1)?.output.address.toLowerCase() === whbar) parts.push("HBAR");
  return {
    scope: "saucer_venue_aware_exact_output" as const,
    summary: parts.join(" → "),
    routeId: selected.routeId,
    minimumLiquidityUsd: selected.minimumLiquidityUsd,
    wrapperBoundary: asset.destination.wrapper
      ? {
          kind: "erc20_to_hts" as const,
          contract: asset.destination.wrapper.address,
          input: { symbol: asset.symbol, address: asset.destination.address, decimals: asset.destination.decimals },
          output: { symbol: firstSymbol, tokenId: asset.destination.wrapper.htsTokenId, address: asset.destination.wrapper.htsAddress },
          rate: asset.destination.wrapper.rate,
        }
      : null,
    hops,
    unwrapBoundary: {
      kind: "whbar_to_hbar" as const,
      input: hops.at(-1)?.output ?? null,
      output: { symbol: "HBAR", decimals: 8 },
    },
    amountContext: {
      mode: "exact_output" as const,
      routeInputAmount: selected.amountIn,
      routeOutputTinybar: selected.amountOutTinybar,
      perHopAmountsAvailable: selected.perHopAmountsAvailable,
    },
    discovery: selected.discovery,
    disclosure: "Bounded single-venue Saucer V1 and V2 candidates are ranked only after venue-specific exact-output simulation. Mixed-venue paths remain unsupported; displayed liquidity is a risk signal while price-impact and explicit max-slippage controls remain hard gates.",
  };
}
