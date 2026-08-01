import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { ProductJourneyRecord, StoredProductQuote } from "./product-lifecycle-store.js";
import { requirementsFromQuote } from "./product-payment.js";
import { productContractAddresses } from "./support.js";

export type Refuel402PaymentRequired = PaymentRequired & {
  refuel402: {
    schema: "refuel402.exact-permit2-payment-required.v1";
    journeyId: string;
    quoteId: string;
    chainId: 295 | 296;
    permit2: string;
    spender: string;
    contextHash: string;
  };
};

export function createProductPaymentRequired(input: {
  quote: StoredProductQuote;
  journey: ProductJourneyRecord;
  resourceUrl: string;
}): { body: Refuel402PaymentRequired; header: string } {
  const requirements = requirementsFromQuote(input.quote);
  const contracts = productContractAddresses(input.quote.mode);
  const body: Refuel402PaymentRequired = {
    x402Version: 2,
    resource: {
      url: input.resourceUrl,
      description: "Settle the quote-bound Refuel402 fee before the sponsored HBAR conversion",
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "exact",
      network: requirements.network,
      asset: requirements.token,
      amount: requirements.amount,
      payTo: requirements.recipient,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: "permit2",
        refuel402Witness: "Refuel402ExactPayment",
      },
    }],
    refuel402: {
      schema: "refuel402.exact-permit2-payment-required.v1",
      journeyId: input.journey.id,
      quoteId: typeof input.quote.record.quoteId === "string" ? input.quote.record.quoteId : input.quote.quoteId,
      chainId: requirements.chainId,
      permit2: contracts.permit2,
      spender: requirements.spender,
      contextHash: requirements.contextHash,
    },
  };
  return { body, header: encodePaymentRequiredHeader(body) };
}
