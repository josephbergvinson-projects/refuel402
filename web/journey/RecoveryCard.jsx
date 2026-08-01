import { state } from "../store.js";
import { Card, StatePill } from "../ui/index.js";
import { journeyHeading, journeySubtitle, recoveryFraming } from "../journey-presentation.js";
import { Evidence, JourneyHeader, JourneyProgress, PrimaryAction, ServerNote, ServerReason } from "./JourneyChrome.jsx";

/**
 * Every server decision that stops a journey: blocked, operator_review,
 * reconcile_submissions, and a source boundary that never broadcast. The card
 * restates what the SERVER decided, offers the one action that exists, and
 * keeps the raw reason and journey id behind Details. It never diagnoses.
 */
export function RecoveryCard() {
  const recovery = state.recovery.value;
  const presentation = state.journeyPresentation.value;
  const framing = recoveryFraming(recovery);
  const heading = journeyHeading({ surface: "recovery", recovery, routeMode: state.routeMode.value, presentation });
  const error = state.error.value;
  // applyServerJourney mirrors the recovery reason into `error`; showing it
  // twice would read as two problems instead of one decision.
  const serverNote = error && error !== presentation.reason && error !== recovery?.reason ? error : null;

  return (
    <Card class="journey-surface journey-recovery" aria-label="Journey needs a decision">
      <JourneyHeader
        title={heading.title}
        subtitle={journeySubtitle({ quote: state.quote.value, routeMode: state.routeMode.value })}
        tone="warning"
        aside={<StatePill tone="warning">Paused</StatePill>}
      />

      {/* A plain restatement replaces the server's wording on the surface; the
          verbatim reason is always in Details. With no restatement for this
          decision the server's own sentence is shown rather than nothing. */}
      {framing.plain
        ? <p class="journey-recovery__plain no-clip">{framing.plain}</p>
        : <ServerReason reason={framing.reason ?? presentation.reason} />}
      <ServerNote tone="warning">{serverNote}</ServerNote>

      <JourneyProgress />

      <PrimaryAction newTransferLabel="Start a separate transfer · this one stays preserved" />
      <Evidence />
    </Card>
  );
}
