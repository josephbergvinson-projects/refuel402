import { actions, state } from "../store.js";
import { Button, Disclosure, StatePill } from "../ui/index.js";
import { evidenceRows, journeySteps, primaryActionCopy } from "../journey-presentation.js";
import { deriveJourneyPhases } from "../journey-view-model.js";

/**
 * Grammar shared by every post-start surface: one header, one Details
 * disclosure holding the technical evidence, and one primary action.
 */

export function JourneyHeader({ title, subtitle, aside, tone = "neutral" }) {
  return (
    <header class="journey-head">
      <div class="journey-head__copy">
        <h2 class={`journey-head__title journey-head__title--${tone}`}>{title}</h2>
        {subtitle ? <p class="journey-head__sub no-clip tabular">{subtitle}</p> : null}
      </div>
      {aside ? <div class="journey-head__aside">{aside}</div> : null}
    </header>
  );
}

/**
 * The single Details disclosure. Every technical artifact the plain-language
 * surface moved out of the way lives here; nothing is deleted.
 */
export function Evidence({ rows, label = "Details", note }) {
  const list = rows ?? evidenceRows({
    journey: state.journey.value,
    quote: state.quote.value,
    mode: state.mode.value,
    networks: state.options.value?.networks ?? [],
  });
  if (!list.length) return null;
  return (
    <Disclosure
      class="journey-evidence"
      summary={
        <span class="journey-evidence__summary">
          <span>{label}</span>
          <span class="journey-evidence__hint">technical evidence</span>
        </span>
      }
    >
      {note ? <p class="journey-evidence__note">{note}</p> : null}
      <dl class="journey-evidence__rows">
        {/* Repeated labels are legitimate here (one row per submission), so the
            stable derived order is the key rather than the label. */}
        {list.map((row, index) => (
          <div class="journey-evidence__row" key={index}>
            <dt>{row.label}</dt>
            <dd class="no-clip tabular" title={row.title}>
              {/* A reference the chain can confirm is a link. One without an
                  explorer stays plain text rather than becoming a dead link. */}
              {row.href
                ? <a href={row.href} target="_blank" rel="noreferrer noopener">{row.value}</a>
                : row.value}
            </dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

/**
 * The journey surface: three phases, one status line, and the transactions.
 *
 * This replaced a seven-row checklist with a paragraph under each row. That
 * shape promised to walk the owner through seven interactions; in truth every
 * signature happens up front in MetaMask and the rest is the chain working. The
 * seven-step model is unchanged and still feeds Details — it is the display that
 * folds to origin → transit → destination, the shape every bridge UI already
 * uses. `activeNote` rides under the status line.
 */
export function JourneyProgress({ activeNote = null }) {
  const steps = journeySteps({
    progress: state.journeyPresentation.value.progress,
    journey: state.journey.value,
    mode: state.mode.value,
    networks: state.options.value?.networks ?? [],
  });
  const phases = deriveJourneyPhases(state.journeyPresentation.value.progress);
  const active = steps.find((step) => step.status === "current" || step.status === "action_required");
  // Only transactions that actually exist, in the order they happened.
  const receipts = steps.filter((step) => step.link && step.reference);

  return (
    <section class="journey-phases" aria-label="Journey progress">
      <ol class="journey-phases__track">
        {phases.map((phase) => (
          <li key={phase.id} class={`journey-phase is-${phase.status}`}>
            <span class="journey-phase__dot" aria-hidden="true" />
            <span class="journey-phase__label">{phase.label}</span>
            <span class="sr-only">{` — ${phase.status === "done" ? "done" : phase.status === "current" ? "in progress" : phase.status === "action_required" ? "action needed" : "pending"}`}</span>
          </li>
        ))}
      </ol>

      {active
        ? (
          <p class={`journey-phases__status is-${active.status}`}>
            <span class="journey-phases__status-title">{active.title}</span>
            {active.detail ? <span class="journey-phases__status-detail">{active.detail}</span> : null}
          </p>
        )
        : null}

      {activeNote}

      {receipts.length
        ? (
          <ul class="journey-receipts" aria-label="Transactions">
            {receipts.map((step) => (
              <li key={step.id}>
                <a class="journey-receipt" href={step.link.href} target="_blank" rel="noreferrer" title={step.reference}>
                  <span class="journey-receipt__what">{step.title}</span>
                  <span class="journey-receipt__ref tabular">{step.referenceShort}</span>
                  <span class="journey-receipt__go" aria-hidden="true">↗</span>
                </a>
              </li>
            ))}
          </ul>
        )
        : null}
    </section>
  );
}

/** A calm, non-blocking note. Server text is never rendered as a wall of red. */
export function ServerNote({ children, tone = "info" }) {
  if (!children) return null;
  return <p class={`journey-note journey-note--${tone}`} role={tone === "warning" ? "status" : undefined}>{children}</p>;
}

/**
 * The one primary action. Every branch is an explicit click routed through the
 * store's single dispatch; nothing on these surfaces signs or submits on its own.
 */
export function PrimaryAction({ exactHbar = null, newTransferLabel = "Start a separate transfer" }) {
  const intent = state.primaryIntent.value;
  const copy = primaryActionCopy(intent, {
    presentation: state.journeyPresentation.value,
    routeMode: state.routeMode.value,
    exactHbar,
    quoteRefresh: state.quoteRefresh.value,
  });
  return (
    <div class="journey-action">
      <Button
        // A disabled gradient CTA reads as the action to take; a waiting or
        // blocked state must not look like one.
        variant={intent.disabled && !intent.busy ? "secondary" : "primary"}
        size="lg"
        block
        disabled={intent.disabled}
        loading={intent.busy}
        onClick={() => { void actions.submitPrimary(); }}
      >
        {copy.label}
      </Button>
      {copy.note ? <p class="journey-action__note">{copy.note}</p> : null}
      {state.recoveryCancellable.value
        ? (
          <Button variant="ghost" size="sm" block onClick={() => actions.cancelRecovery()}>
            Stop reading this journey
          </Button>
        )
        : null}
      {intent.allowNewTransfer
        ? (
          <Button
            variant="secondary"
            size="md"
            block
            onClick={() => { void actions.startNewTransfer(); }}
            hint="Archives this journey locally. The server record, hashes, and events are never deleted or replayed."
          >
            {newTransferLabel}
          </Button>
        )
        : null}
    </div>
  );
}

/** Live server phrasing kept visible where it is the actual explanation. */
export function ServerReason({ reason }) {
  if (!reason) return null;
  return (
    <div class="journey-server-reason">
      <StatePill tone="neutral">What the server says</StatePill>
      <p class="no-clip">{reason}</p>
    </div>
  );
}
