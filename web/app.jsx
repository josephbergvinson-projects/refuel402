import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, state } from "./store.js";
import { Button, Segmented } from "./ui/index.js";
import { ComposeCard } from "./compose/ComposeCard.jsx";
import { JourneyView } from "./journey/JourneyView.jsx";
import { ActivityDrawer } from "./journey/ActivityDrawer.jsx";
import { WalletDialog } from "./WalletDialog.jsx";
import { bridgeArrivalEvidence, journeySurface } from "./journey-presentation.js";
import {
  activityLabel,
  networkLabel,
  shellStatus,
  surfaceFocusKey,
  walletAriaLabel,
  walletChainLabel,
  walletLabel,
} from "./shell-view-model.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/app.css";

function TopBar() {
  const [walletOpen, setWalletOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const account = state.account.value;
  const mode = state.mode.value;
  const activityCount = state.activityItems.value.length;
  // The chain the wallet is on — the origin of the transfer, and a different
  // question from the Hedera network it arrives on. The two were conflated by a
  // green "Hedera Mainnet" status pill that never described the wallet at all.
  const chainLabel = walletChainLabel(state.chainId.value, state.networkCatalog.value);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await actions.disconnectWallet();
      setWalletOpen(false);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <header class="top-bar">
      <h1 class="brand">
        <a href="/" aria-label="Refuel402 home">
          <span class="brand-mark" aria-hidden="true">◎</span>
          <span>Refuel<em>402</em></span>
        </a>
      </h1>
      <div class="top-bar__actions">
        <span class="top-bar__destination">
          {/* The visible "To Hedera" label is gone: both options name Hedera in
              their own hint and the accessible name below still says which
              question the switch answers. */}
          <Segmented
            label="Hedera destination network"
            size="sm"
            value={mode}
            disabled={state.draftLocked.value}
            options={[
              { value: "testnet", label: "Testnet", hint: "Arrive on Hedera Testnet" },
              { value: "mainnet", label: "Mainnet", hint: "Arrive on Hedera Mainnet" },
            ]}
            onChange={(next) => { void actions.setMode(next); }}
          />
        </span>
        <Button
          variant="ghost"
          size="md"
          onClick={() => { void actions.openActivity(); }}
          aria-haspopup="dialog"
          aria-expanded={state.activityOpen.value ? "true" : "false"}
          aria-label={activityLabel(activityCount)}
          hint="Server-recorded journeys for the connected account"
        >
          Journeys{activityCount ? <span class="top-bar__count" aria-hidden="true">{activityCount}</span> : null}
        </Button>
        <Button
          variant="secondary"
          size="md"
          class="top-bar__wallet"
          onClick={() => { if (account) setWalletOpen(true); else void actions.connectWallet(); }}
          aria-haspopup={account ? "dialog" : undefined}
          aria-expanded={account ? (walletOpen ? "true" : "false") : undefined}
          aria-label={walletAriaLabel(account)}
          hint={account && chainLabel ? `Connected on ${chainLabel}` : undefined}
        >
          {/* Address only. The chain was a second line of text inside the button
              that nobody needed there: the origin network is already named on the
              send box, and the wallet dialog states it in full. */}
          {walletLabel(account)}
        </Button>
      </div>

      <WalletDialog
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        account={account}
        chainLabel={chainLabel}
        destinationLabel={networkLabel(mode)}
        busy={disconnecting}
        onDisconnect={disconnect}
      />
    </header>
  );
}

/**
 * The offer that replaced silent adoption. Opening the site used to take the
 * stored pointer and put that journey on screen instead of the compose card,
 * which is how a transfer that was never sent came to hijack a fresh visit — and,
 * because an adopted journey locks the draft, it also froze the origin network on
 * the catalog default. A journey with funds actually in the air still resumes by
 * itself; everything else asks first, here, above an untouched compose card.
 */
function ResumeOffer() {
  const offer = state.resumeOffer.value;
  if (!offer) return null;
  const when = offer.updatedAt
    ? new Date(Number(offer.updatedAt)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : null;
  return (
    <div class="resume-offer" role="region" aria-label="Unfinished journey">
      <p class="resume-offer__text">
        You have an unfinished transfer{when ? ` from ${when}` : ""}. Nothing is in flight and nothing was spent.
      </p>
      <div class="resume-offer__actions">
        <Button variant="secondary" size="sm" onClick={() => { void actions.acceptResumeOffer(); }}>
          Open it
        </Button>
        <Button variant="ghost" size="sm" onClick={() => actions.dismissResumeOffer()}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function App() {
  const stageRef = useRef(null);
  const firstRender = useRef(true);
  const focusKey = surfaceFocusKey({
    surface: state.surface.value,
    journeySurface: state.surface.value === "journey"
      ? journeySurface({
          journeyId: state.journeyId.value,
          recovery: state.recovery.value,
          recoveryProvisional: state.recoveryProvisional.value,
          quoteConsentGate: state.quoteConsentGate.value,
          routeMode: state.routeMode.value,
          arrivalConfirmed: Boolean(bridgeArrivalEvidence(state.journey.value)),
        })
      : null,
  });

  // A surface swap is a view change: focus lands on the stage so keyboard and
  // screen-reader users are not left on a control that no longer exists. The
  // first paint is skipped — stealing focus on load is its own bug. preventScroll
  // keeps the browser from parking a tall card mid-scroll; the top of the new
  // surface is the only sensible landing.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stageRef.current?.focus?.({ preventScroll: true });
    globalThis.scrollTo?.({ top: 0 });
  }, [focusKey]);

  return (
    <>
      <TopBar />
      <main class="stage" ref={stageRef} tabIndex={-1} aria-label="Transfer">
        {state.surface.value === "journey"
          ? <JourneyView />
          : <><ResumeOffer /><ComposeCard /></>}
      </main>
      <p class="sr-only" role="status" aria-live="polite">
        {shellStatus({
          surface: state.surface.value,
          loading: state.loading.value,
          error: state.error.value,
          quoteRefresh: state.quoteRefresh.value,
          activityOpen: state.activityOpen.value,
        })}
      </p>
      <footer class="site-footer">
        <span>Refuel402</span>
        <nav aria-label="Evidence">
          <a href={actions.endpoint("/v1/product/options?mode=mainnet")}>Product API</a>
          <a href="/developer.html">Developer diagnostics</a>
        </nav>
      </footer>
      <ActivityDrawer />
    </>
  );
}

const root = document.getElementById("root");
render(<App />, root);

globalThis.addEventListener?.("pagehide", () => actions.dispose(), { once: true });

await actions.init();
