import { actions, state } from "../store.js";
import { Card, StatePill } from "../ui/index.js";
import { journeySubtitle, originHashState } from "../journey-presentation.js";
import { Evidence, JourneyHeader, PrimaryAction, ServerNote } from "./JourneyChrome.jsx";

const FIELD_ID = "origin-transaction-hash";

/**
 * The boundary-without-hash hard stop. The server reached a source-wallet
 * consent boundary with no authoritative bridge hash and named /bridge/adopt as
 * the only owner-driven exit. Nothing here is auto-filled, guessed, or
 * submitted: the owner types one hash and signs an ownership consent for it.
 */
export function AdoptCard() {
  const recovery = state.recovery.value;
  const hash = originHashState(state.bridgeAdoptionHash.value);
  const error = state.error.value;
  const serverNote = error && error !== recovery?.reason ? error : null;

  return (
    <Card class="journey-surface journey-adopt" aria-label="Bind the origin transaction">
      <JourneyHeader
        title="We need the transaction hash"
        subtitle={journeySubtitle({ quote: state.quote.value, routeMode: state.routeMode.value })}
        tone="warning"
        aside={<StatePill tone="warning">Needs your input</StatePill>}
      />

      <p class="journey-adopt__plain no-clip">
        Your wallet reached the send step, but no bridge transaction hash was ever recorded here. If your wallet did broadcast
        one, paste it below. Nothing is filled in or guessed for you, and nothing is sent or re-sent.
      </p>

      <div class="journey-field">
        <label class="journey-field__label" for={FIELD_ID}>Origin transaction hash</label>
        <input
          id={FIELD_ID}
          class="journey-field__input tabular no-clip"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellcheck={false}
          placeholder="0x…"
          value={state.bridgeAdoptionHash.value}
          aria-invalid={!hash.empty && !hash.valid ? "true" : undefined}
          aria-describedby={`${FIELD_ID}-help`}
          disabled={state.loading.value}
          onInput={(event) => actions.setBridgeAdoptionHash(event.currentTarget.value)}
        />
        <p id={`${FIELD_ID}-help`} class={`journey-field__help${!hash.empty && !hash.valid ? " is-invalid" : ""}`}>
          {hash.message}
        </p>
      </div>

      <p class="journey-adopt__consent">
        Before anything binds you sign a typed off-chain consent (EIP-712) naming this journey and that exact hash. The server
        binds it only if chain and provider evidence match; it is never a transaction and never moves funds.
      </p>

      {/* The server's own wording names an endpoint path; it is evidence, so it
          lives in Details verbatim rather than on the surface. */}
      <ServerNote tone="warning">{serverNote}</ServerNote>

      <PrimaryAction newTransferLabel="Start a separate transfer · preserve this for review" />
      <Evidence />
    </Card>
  );
}
