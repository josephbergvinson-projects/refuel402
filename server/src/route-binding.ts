import crypto from "node:crypto";

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") throw new Error("selected Saucer route evidence is missing");
  return value as Record<string, any>;
}

export type BoundSaucerExecutionHop = {
  toToken: string;
  fee: number;
  venue: "v1" | "v2";
};

function selectedRoute(evidence: unknown) {
  const root = record(evidence);
  const selected = record(root.selectedRoute);
  const hops = Array.isArray(selected.hops) ? selected.hops.map(record) : [];
  const tokens = Array.isArray(selected.tokens) ? selected.tokens.map(String) : [];
  const fees = Array.isArray(selected.fees) ? selected.fees.map(Number) : [];
  if (!root.graphHash || !selected.routeId || !["v1", "v2"].includes(selected.venue) || hops.length === 0) {
    throw new Error("selected Saucer route evidence is incomplete");
  }
  if (tokens.length !== hops.length + 1 || fees.length !== hops.length) {
    throw new Error("selected Saucer route token or fee vector is incomplete");
  }
  for (const [index, hop] of hops.entries()) {
    if (
      String(record(hop.input).address).toLowerCase() !== tokens[index]!.toLowerCase() ||
      String(record(hop.output).address).toLowerCase() !== tokens[index + 1]!.toLowerCase() ||
      Number(hop.feeTier) !== fees[index] ||
      hop.venue !== selected.venue
    ) {
      throw new Error("selected Saucer route vectors and hop evidence disagree");
    }
  }
  return { root, selected, hops, tokens, fees };
}

export function saucerExecutionRoute(evidence: unknown): BoundSaucerExecutionHop[] {
  const { selected, hops } = selectedRoute(evidence);
  return hops.map((hop) => ({
    toToken: String(record(hop.output).address),
    fee: Number(hop.feeTier),
    venue: selected.venue as "v1" | "v2",
  }));
}

export function bindSaucerRoute(evidence: unknown): string {
  const { root, selected, hops, tokens, fees } = selectedRoute(evidence);
  const canonical = {
    graphHash: String(root.graphHash),
    routeId: String(selected.routeId),
    venue: String(selected.venue),
    tokens,
    fees,
    amountIn: String(selected.amountIn),
    amountOutTinybar: String(selected.amountOutTinybar),
    simulatedAt: String(selected.simulatedAt),
    expiresAt: String(selected.expiresAt),
    hops: hops.map((hop) => ({
      index: Number(hop.index),
      venue: String(hop.venue),
      input: String(record(hop.input).address).toLowerCase(),
      output: String(record(hop.output).address).toLowerCase(),
      poolId: String(record(hop.pool).id),
      contractId: String(record(hop.pool).contractId),
      feeTier: Number(hop.feeTier),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
