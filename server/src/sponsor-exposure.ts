// One HAPI sponsor account funds three spend paths: the legacy technical API,
// product destination activation, and every policy-RPC sponsored intent. Each
// path gates on the same DAILY_SPONSOR_CAP_TINYBAR, so a cap decision that reads
// only its own ledger lets the other two spend straight past it. Every daily-cap
// decision goes through this reader instead.
//
// x402 facilitator settlement is paid by the facilitator account, not the
// sponsor, and is priced separately - it is intentionally excluded.

export type LegacySponsorLedger = {
  exposureSince(sinceMs: number): bigint | Promise<bigint>;
};

/**
 * excludeRawTransactionHash omits the one sponsored-intent authorization the
 * caller is deciding on. The policy-RPC path commits state='consumed' before the
 * submitter runs its cap check, so without this the transaction under decision
 * is counted against its own allowance and the effective cap becomes
 * dailyCap - allowance - after the x402 payment has already settled.
 */
export type SponsorExposureOptions = { excludeRawTransactionHash?: string };

export type ProductSponsorLedger = {
  activationExposureSince(cutoffMs: number): Promise<bigint>;
  sponsoredIntentExposureSince(cutoffMs: number, options?: SponsorExposureOptions): Promise<bigint>;
  refuelAuthorizationExposureSince?(cutoffMs: number): Promise<bigint>;
};

export type SponsorExposureReader = (
  cutoffMs: number,
  options?: SponsorExposureOptions,
) => Promise<bigint>;

export function createSponsorExposureReader(options: {
  legacy: LegacySponsorLedger;
  product?: ProductSponsorLedger | null;
}): SponsorExposureReader {
  return async (cutoffMs: number, read?: SponsorExposureOptions) => {
    const product = options.product;
    // The legacy and activation ledgers cannot hold the excluded authorization,
    // so they ignore the option.
    const [legacy, activation, sponsoredIntents, refuelAuthorizations] = await Promise.all([
      Promise.resolve(options.legacy.exposureSince(cutoffMs)),
      product ? product.activationExposureSince(cutoffMs) : Promise.resolve(0n),
      product ? product.sponsoredIntentExposureSince(cutoffMs, read) : Promise.resolve(0n),
      product?.refuelAuthorizationExposureSince
        ? product.refuelAuthorizationExposureSince(cutoffMs)
        : Promise.resolve(0n),
    ]);
    return BigInt(legacy) + BigInt(activation) + BigInt(sponsoredIntents) + BigInt(refuelAuthorizations);
  };
}
