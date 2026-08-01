import { state } from "../store.js";
import { Card, StatePill } from "../ui/index.js";
import { journeySubtitle, termsChangeRows } from "../journey-presentation.js";
import { Evidence, JourneyHeader, PrimaryAction, ServerNote } from "./JourneyChrome.jsx";

/**
 * QUOTE_ECONOMICS_WORSENED: a post-consent re-quote came back worse than the
 * terms the owner agreed to, so the server wrote nothing and stopped. The only
 * continuation is one explicit acceptance — this never auto-accepts.
 */
export function TermsChangedCard() {
  const gate = state.quoteConsentGate.value;
  const rows = termsChangeRows(gate, state.quote.value);

  return (
    <Card class="journey-surface journey-terms" aria-label="The route price moved">
      <JourneyHeader
        title="The route price moved"
        subtitle={journeySubtitle({ quote: state.quote.value, routeMode: state.routeMode.value })}
        tone="warning"
        aside={<StatePill tone="warning">Your decision</StatePill>}
      />

      <p class="journey-terms__plain no-clip">
        Nothing was signed, submitted, or charged. The refreshed route is worse than the terms you approved, so the server
        stopped instead of continuing. Here is exactly what changed.
      </p>

      <ul class="journey-terms__rows">
        {rows.map((row) => (
          <li class={`journey-terms__row${row.changed ? " is-changed" : ""}`} key={row.field}>
            <span class="journey-terms__label">{row.label}</span>
            {row.changed
              ? (
                <span class="journey-terms__values tabular no-clip">
                  <s class="journey-terms__before">{row.before}</s>
                  <span class="journey-terms__after-group">
                    <span class="journey-terms__arrow" aria-hidden="true">→</span>
                    <strong class="journey-terms__after">{row.after}</strong>
                  </span>
                  <span class="sr-only">{` changed from ${row.before} to ${row.after}`}</span>
                </span>
              )
              : <span class="journey-terms__values tabular no-clip"><strong>{row.after}</strong><span class="sr-only"> unchanged</span></span>}
          </li>
        ))}
      </ul>

      {rows.length
        ? null
        : <ServerNote tone="warning">The server refused the refreshed quote but returned no comparison. Nothing continued; the details below hold the raw decision.</ServerNote>}

      <PrimaryAction newTransferLabel="Start a new transfer · preserve this journey" />
      <Evidence
        note="Accepting re-quotes at the live price. The server still refuses anything worse than the terms you originally consented to, so acceptance can only end equal or better."
      />
    </Card>
  );
}
