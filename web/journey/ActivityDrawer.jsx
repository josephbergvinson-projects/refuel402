import { actions, state } from "../store.js";
import { Button, Card, Disclosure, Modal, Skeleton, StatePill } from "../ui/index.js";
import { activityFacts, activityStateTone } from "../journey-presentation.js";
import { activityActionLabel } from "../journey-view-model.js";

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
}

function ActivityRow({ row, busy, abandoning }) {
  const facts = activityFacts(row);
  const when = new Date(row.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  // Rows are named by what they are, not by a truncated journey uuid.
  const name = `${facts.title} ${when}`;
  return (
    <Card as="article" tone="field" class="activity-row" role="listitem">
      <div class="activity-row__head">
        <h3>{facts.title}</h3>
        <StatePill tone={activityStateTone(row.state)}>
          {facts.state}
        </StatePill>
      </div>
      <p class="activity-row__facts no-clip">
        {facts.facts.length
          ? facts.facts.map((fact, index) => (
            <span key={fact.key} class="tabular" title={fact.title}>
              {index ? " · " : ""}
              {fact.text}
            </span>
          ))
          : "Server record preserved"}
      </p>
      <p class="activity-row__meta">
        <span>{when}</span>
      </p>
      <div class="activity-row__actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || Boolean(abandoning)}
          onClick={() => { void actions.selectActivityJourney(row.journeyId); }}
          aria-label={`${activityActionLabel(row.action)} ${name}`}
        >
          {activityActionLabel(row.action)}
        </Button>
        {/* Only ever offered on rows the SERVER marked abandonable. */}
        {row.abandonable
          ? (
            <Button
              variant="ghost"
              size="sm"
              class="activity-row__abandon"
              loading={abandoning === row.journeyId}
              disabled={Boolean(abandoning) && abandoning !== row.journeyId}
              onClick={() => { void actions.abandonJourney(row.journeyId); }}
              aria-label={`Abandon draft ${name}`}
              hint="Removes this draft from your list. One wallet signature; nothing on chain moves."
            >
              Abandon
            </Button>
          )
          : null}
      </div>
    </Card>
  );
}

/**
 * Server-bounded, account-scoped history. Every row comes from a paged server
 * read for the connected account only; the store aborts in-flight reads and
 * empties this list the moment the account changes, and opening a row is a
 * server read of that one journey — it never mutates or resumes another.
 *
 * Drafts — the rows the server marked `abandonable`, meaning they never reached
 * the outside world — are collapsed away from the journeys that actually did
 * something, because a list where a real bridged transfer sits between four
 * empty quotes buries the thing worth looking at.
 */
export function ActivityDrawer() {
  const account = state.account.value;
  const items = state.activityItems.value;
  const busy = state.loading.value;
  const abandoning = state.activityAbandoning.value;
  const active = items.filter((row) => !row.abandonable);
  const drafts = items.filter((row) => row.abandonable);
  const summary = !account
    ? "Connect MetaMask to view this account’s journeys."
    : state.activityError.value
      ? state.activityError.value
      : state.activityLoading.value && !items.length
        ? "Loading server activity…"
        : items.length
          ? `${active.length} journey${active.length === 1 ? "" : "s"}${drafts.length ? ` and ${drafts.length} draft${drafts.length === 1 ? "" : "s"}` : ""} for ${shortAddress(account)}. Opening one never changes another journey.`
          : `No preserved journeys for ${shortAddress(account)}.`;

  return (
    <Modal
      open={state.activityOpen.value}
      onClose={() => actions.closeActivity()}
      title="Journeys"
      placement="right"
    >
      <p class="activity-summary" aria-live="polite">{summary}</p>
      <div class="activity-list" role="list">
        {state.activityLoading.value && !items.length ? <Skeleton lines={3} height="18px" /> : null}
        {account ? active.map((row) => <ActivityRow key={row.journeyId} row={row} busy={busy} abandoning={abandoning} />) : null}
      </div>

      {account && drafts.length
        ? (
          <Disclosure
            class="activity-drafts"
            summary={
              <span class="activity-drafts__summary">
                <span>Drafts</span>
                <span class="activity-drafts__hint">{drafts.length} never left your wallet</span>
              </span>
            }
          >
            <p class="activity-drafts__note">
              These never reached a bridge, a payment, or the chain. Abandoning one removes it
              from this list for good; the server record and its events are preserved and never
              deleted.
            </p>
            <div class="activity-list" role="list">
              {drafts.map((row) => <ActivityRow key={row.journeyId} row={row} busy={busy} abandoning={abandoning} />)}
            </div>
          </Disclosure>
        )
        : null}

      {state.activityHasMore.value
        ? (
          <Button
            variant="secondary"
            size="sm"
            block
            loading={state.activityLoading.value}
            onClick={() => { void actions.loadMoreActivity(); }}
          >
            Load more
          </Button>
        )
        : null}
    </Modal>
  );
}
