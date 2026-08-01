import { Button, Modal, StatePill } from "./ui/index.js";

/**
 * The wallet control behind the top-bar chip. Connecting is one click in the top
 * bar; everything else about the connection — which address, which chain that
 * wallet is on, and ending the session — lives here, because a chip that only
 * reconnects is a control that does nothing once you are connected.
 *
 * Rendered as a focus-trapped Modal rather than a floating popover: the project
 * has no popover primitive, and Modal already owns Escape, the focus trap, and
 * the dialog aria wiring.
 */
export function WalletDialog({
  open,
  onClose,
  account,
  chainLabel,
  destinationLabel,
  busy = false,
  onDisconnect,
}) {
  return (
    <Modal open={open} onClose={onClose} title="Wallet" size="sm" class="wallet-dialog">
      <dl class="wallet-dialog__rows">
        <div class="wallet-dialog__row">
          <dt>Address</dt>
          <dd class="tabular no-clip" title={account ?? undefined}>{account ?? "Not connected"}</dd>
        </div>
        <div class="wallet-dialog__row">
          <dt>Wallet network</dt>
          <dd>
            {chainLabel
              ? <StatePill tone="neutral" dot>{chainLabel}</StatePill>
              : <span class="wallet-dialog__muted">Unknown</span>}
          </dd>
        </div>
        <div class="wallet-dialog__row">
          <dt>Bridging to</dt>
          <dd><StatePill tone="brand">{destinationLabel}</StatePill></dd>
        </div>
      </dl>

      <p class="wallet-dialog__note">
        You send from whichever network your wallet is on and receive on {destinationLabel},
        at this same address. Refuel402 never asks you to move funds to another address.
      </p>

      <Button
        variant="danger"
        size="md"
        block
        disabled={!account || busy}
        loading={busy}
        onClick={() => { void onDisconnect?.(); }}
      >
        Disconnect
      </Button>
      <p class="wallet-dialog__note">
        Disconnecting clears this session and asks your wallet to revoke the site's access.
        A wallet that cannot revoke access may reconnect when you reload.
      </p>
    </Modal>
  );
}
