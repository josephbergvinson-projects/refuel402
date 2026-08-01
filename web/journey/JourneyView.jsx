import { state } from "../store.js";
import { Card, Skeleton, StatePill } from "../ui/index.js";
import { bridgeArrivalEvidence, journeySubtitle, journeySurface } from "../journey-presentation.js";
import { AdoptCard } from "./AdoptCard.jsx";
import { ArrivalConsent } from "./ArrivalConsent.jsx";
import { Evidence, JourneyHeader, PrimaryAction } from "./JourneyChrome.jsx";
import { JourneyTimeline } from "./JourneyTimeline.jsx";
import { RecoveryCard } from "./RecoveryCard.jsx";
import { TermsChangedCard } from "./TermsChangedCard.jsx";
import "./journey.css";

/**
 * A selected id is provisional. Until the server confirms that exact journey
 * nothing lifecycle-shaped is rendered and no action is offered.
 *
 * It does, however, render a failure. This card used to show only a heading and a
 * skeleton, so a run that died at the wallet — before MetaMask ever opened — was
 * presented as a read in progress, and the reason it died was on screen nowhere at
 * all. A run that failed must not look like a journey being loaded.
 */
function RecheckingCard() {
  const failure = state.error.value;
  return (
    <Card class="journey-surface" aria-label="Checking this journey">
      <JourneyHeader
        title="Checking this journey"
        subtitle={journeySubtitle({ quote: state.quote.value, routeMode: state.routeMode.value })}
        aside={<StatePill tone="neutral" live="polite">Reading</StatePill>}
      />
      {failure ? <p class="journey-note journey-note--warning">{failure}</p> : null}
      <p class="journey-note journey-note--info">
        The server decides what this journey is and what may happen next, so nothing is shown or offered until it answers.
      </p>
      <Skeleton lines={3} height="16px" label="Reading the journey record" />
      <PrimaryAction newTransferLabel="Start a separate transfer" />
      <Evidence />
    </Card>
  );
}

/**
 * Router for every post-start surface. The selection is pure
 * (journeySurface in journey-presentation.js) and mirrors the intent
 * precedence in store.js: the server's worsened-terms gate outranks the
 * provisional re-check, and a provisional decision never renders an action.
 */
export function JourneyView() {
  const surface = journeySurface({
    journeyId: state.journeyId.value,
    recovery: state.recovery.value,
    recoveryProvisional: state.recoveryProvisional.value,
    quoteConsentGate: state.quoteConsentGate.value,
    routeMode: state.routeMode.value,
    arrivalConfirmed: Boolean(bridgeArrivalEvidence(state.journey.value)),
  });
  if (surface === "terms_changed") return <TermsChangedCard />;
  if (surface === "rechecking") return <RecheckingCard />;
  if (surface === "adopt") return <AdoptCard />;
  if (surface === "arrival_consent") return <ArrivalConsent />;
  if (surface === "recovery") return <RecoveryCard />;
  return <JourneyTimeline />;
}
