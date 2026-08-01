import { AmountInput, Button, TokenPill } from "../ui/index.js";

/**
 * The single input: one amount, one combined token/chain pill. Balance is shown
 * only when the wallet actually returned one — every other status says which
 * status it is instead of rendering a zero.
 *
 * The app follows the wallet's own chain, so `wrong_chain` only survives when
 * the chosen asset does not bridge from the chain the wallet is on. That case
 * gets a button rather than an instruction with nothing to click.
 */
export function SendBox({
  amount,
  onAmount,
  token,
  network,
  fiat,
  balance,
  balanceStatus,
  balanceError,
  disabled = false,
  invalid = false,
  switching = false,
  onPickAsset,
  onMax,
  onSwitchNetwork,
}) {
  const wrongChain = balanceStatus === "wrong_chain";
  const balanceLine = {
    ready: balance ? `Balance ${balance.display}` : null,
    loading: "Balance…",
    wrong_chain: `${token?.symbol ?? "This asset"} bridges from ${network?.name ?? "another network"}`,
    error: balanceError ?? "Balance unavailable",
    idle: null,
  }[balanceStatus ?? "idle"];

  return (
    <section class="compose-box" aria-labelledby="compose-send-label">
      <p class="compose-box__head">
        <span id="compose-send-label">You send</span>
        <span class="compose-box__context">{network?.name ?? "Select a network"}</span>
      </p>
      <div class="compose-box__amount">
        <AmountInput
          value={amount}
          onInput={onAmount}
          size="lg"
          label="Amount to bridge"
          describedBy="compose-send-balance"
          disabled={disabled}
          invalid={invalid}
          placeholder="0"
        />
        <TokenPill
          symbol={token?.symbol ?? "Select"}
          label={token?.symbol ?? "Select asset"}
          icon={token?.icon ?? null}
          chainLabel={network?.name}
          chainIcon={network?.icon ?? null}
          onClick={onPickAsset}
          disabled={disabled}
          ariaLabel={token ? `Change asset — currently ${token.symbol} on ${network?.name ?? "unknown network"}` : "Select an asset to bridge"}
          class="compose-box__pill"
        />
      </div>
      <p class="compose-box__foot" id="compose-send-balance">
        <span class="tabular no-clip" title={fiat?.title}>{fiat?.text ?? ""}</span>
        <span class="compose-box__balance">
          {balanceLine ? <span class="tabular no-clip" title={balance?.title}>{balanceLine}</span> : null}
          {balanceStatus === "ready" && !disabled
            ? <Button variant="ghost" size="sm" class="compose-box__max" onClick={onMax} hint="Use your full balance">MAX</Button>
            : null}
          {wrongChain && !disabled
            ? (
              <Button
                variant="ghost"
                size="sm"
                class="compose-box__switch"
                loading={switching}
                onClick={onSwitchNetwork}
                hint={`Ask your wallet to switch to ${network?.name ?? "the origin network"}`}
              >
                Switch network
              </Button>
            )
            : null}
        </span>
      </p>
    </section>
  );
}
