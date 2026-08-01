import { useRef } from "preact/hooks";
import { state } from "../store.js";
import { Card, Ring, StatePill } from "../ui/index.js";
import {
  arrivalSummary,
  arrivedAmount,
  bridgeArrivalEvidence,
  hederaTransactionUrl,
  quoteFreshness,
  shortHash,
  walletPromptPlan,
} from "../journey-presentation.js";
import { Evidence, JourneyHeader, PrimaryAction, ServerNote } from "./JourneyChrome.jsx";

/**
 * The quote carries no mint timestamp, so the freshness window is the largest
 * remaining value observed for this exact quote id. It resets when the id
 * changes, and it is presentation only: expiry never triggers anything.
 */
function freshnessWindow(reference, quoteId, remaining) {
  if (reference.current.quoteId !== quoteId) reference.current = { quoteId, total: remaining };
  if (remaining > reference.current.total) reference.current.total = remaining;
  return reference.current.total;
}

/**
 * The arrival moment. It states what the server verified, what the next click
 * will ask the wallet for, and nothing beyond that. It never auto-signs, and an
 * expired quote reads as a refresh — not as a failure.
 */
export function ArrivalConsent() {
  const quote = state.quote.value;
  const journey = state.journey.value;
  const quoteState = state.destinationQuoteState.value;
  const summary = arrivalSummary(quote);
  const arrived = arrivedAmount({ journey, quote });
  // journeySurface only routes here from a recorded arrival, so the headline is
  // backed by evidence. The link is what lets the owner check that themselves.
  const arrival = bridgeArrivalEvidence(journey);
  const arrivalHref = hederaTransactionUrl(state.mode.value, arrival?.reference);
  const prompts = walletPromptPlan({ journey, quote });
  const observed = useRef({ quoteId: null, total: 0 });
  const freshness = quoteFreshness({
    remaining: state.quoteSecondsRemaining.value,
    total: freshnessWindow(observed, quote?.quoteId ?? null, state.quoteSecondsRemaining.value),
    expired: !quoteState.live,
  });
  const exactHbar = summary?.exactHbar?.display ?? null;

  return (
    <Card class="journey-surface journey-arrival" aria-label="Arrival and consent">
      <JourneyHeader
        title="Your funds arrived"
        tone="success"
        aside={<StatePill tone="success" dot>On Hedera</StatePill>}
      />

      <p class="journey-arrival__lede no-clip">
        {arrived
          ? <><strong class="tabular" title={arrived.full}>{arrived.display}</strong>{" is at your Hedera address. "}</>
          : "The bridged asset is at your Hedera address. "}
        {exactHbar
          ? (
            <>
              {freshness.expired ? "Refresh the quote to see the current terms for exactly " : "Approve the final step to receive exactly "}
              <strong class="journey-arrival__hbar tabular" title={summary.exactHbar.full}>{exactHbar} HBAR</strong>.
            </>
          )
          : "Approve the final step to finish this journey."}
      </p>

      {arrival?.reference
        ? (
          <p class="journey-arrival__proof">
            {arrivalHref
              ? <a href={arrivalHref} target="_blank" rel="noreferrer noopener">View the arrival on HashScan</a>
              : <span>Arrival credit</span>}
            <span class="tabular no-clip" title={arrival.reference}>{shortHash(arrival.reference)}</span>
          </p>
        )
        : null}

      <div class="journey-arrival__freshness">
        <Ring
          remaining={freshness.remaining}
          total={freshness.total}
          tone={freshness.tone}
          label="Quote freshness"
          caption={freshness.caption}
          hint={freshness.note}
        />
        <p class="journey-arrival__freshness-copy">{freshness.note}</p>
      </div>

      {summary
        ? (
          <dl class={`journey-rows${freshness.expired ? " is-stale" : ""}`}>
            {summary.rows.map((row) => (
              <div class={`journey-rows__row${row.accent ? " is-accent" : ""}`} key={row.key}>
                <dt>{row.label}</dt>
                <dd class="tabular no-clip" title={row.title}>{row.value}</dd>
              </div>
            ))}
          </dl>
        )
        : <ServerNote tone="warning">The destination quote is not loaded yet, so no amounts are shown. Refresh to read the current terms.</ServerNote>}

      {prompts.total
        ? (
          <p class="journey-arrival__prompts no-clip">
            <span>Ahead of you: </span>
            <strong>{prompts.summary}</strong>
          </p>
        )
        : null}

      <PrimaryAction exactHbar={exactHbar} newTransferLabel="Start a new transfer" />
      <Evidence note={`Upcoming prompts: ${prompts.remaining.map((prompt) => prompt.label).join(" → ") || "none"}.`} />
    </Card>
  );
}
