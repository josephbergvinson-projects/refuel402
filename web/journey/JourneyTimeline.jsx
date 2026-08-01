import { state } from "../store.js";
import { Card, StatePill } from "../ui/index.js";
import { bridgeEta, bridgeWaitNote, journeyHeading, journeySubtitle } from "../journey-presentation.js";
import { Evidence, JourneyHeader, JourneyProgress, PrimaryAction, ServerReason } from "./JourneyChrome.jsx";

// This used to promise the journey "lives at the link in your address bar". It no
// longer does — the app never writes an id into the URL — and a transfer with funds
// in the air resumes on its own when you come back, from the server record.
const REASSURANCE = "Safe to close this tab. Saved under Journeys; nothing signs without you.";

/**
 * The in-progress and completed journey surface: status from
 * deriveJourneyProgress, plain-language copy, the provider ETA for the bridge
 * wait, and the reassurance that closing the tab is safe.
 */
export function JourneyTimeline() {
  const journey = state.journey.value;
  const recovery = state.recovery.value;
  const presentation = state.journeyPresentation.value;
  const terminal = recovery?.disposition === "terminal";
  const waiting = recovery?.nextAtomicStep === "poll_bridge";
  const eta = waiting ? bridgeEta({ journey, quote: state.quote.value }) : null;
  const waitNote = bridgeWaitNote(state.recoveryProgress.value);
  const heading = journeyHeading({ surface: "timeline", recovery, routeMode: state.routeMode.value, presentation });

  return (
    <Card class="journey-surface" aria-label="Journey progress">
      <JourneyHeader
        title={heading.title}
        subtitle={journeySubtitle({ quote: state.quote.value, routeMode: state.routeMode.value })}
        tone={terminal ? "success" : "neutral"}
        aside={eta
          ? <StatePill tone="brand" hint={eta.hint}>{eta.overdue ? eta.label : `⏱ ${eta.label}`}</StatePill>
          : terminal
            ? <StatePill tone="success" dot>Complete</StatePill>
            : null}
      />

      <JourneyProgress
        activeNote={terminal
          ? null
          : (
            <div class="journey-reassure">
              {waitNote ? <p class="journey-reassure__status tabular no-clip">{waitNote}</p> : null}
              <p class="journey-reassure__copy">{REASSURANCE}</p>
            </div>
          )}
      />

      {/* A healthy in-progress decision is not an explanation the user needs; its
          wording stays in Details. A completed one is a short, human sentence. */}
      {terminal ? <ServerReason reason={recovery?.reason} /> : null}
      <PrimaryAction newTransferLabel={terminal ? "Start a new transfer" : "Start a separate transfer"} />
      <Evidence />
    </Card>
  );
}
