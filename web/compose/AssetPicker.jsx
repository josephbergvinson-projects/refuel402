import { useEffect, useRef, useState } from "preact/hooks";
import { Modal, StatePill, TokenGlyph, rovingIndex } from "../ui/index.js";
import { derivePickerGroups } from "../compose-view-model.js";

/**
 * Searchable asset selector, grouped by origin chain.
 *
 * Unavailable candidates stay visible and stay focusable with aria-disabled
 * rather than being hidden or made unreachable: the reason a route is not
 * available is product information, and a keyboard user must be able to read it.
 */
export function AssetPicker({
  open,
  onClose,
  networks,
  tokensFor,
  selectedTokenId,
  balances,
  onSelect,
}) {
  const [search, setSearch] = useState("");
  const listRef = useRef(null);

  useEffect(() => { if (!open) setSearch(""); }, [open]);

  // The catalog is only walked while the dialog is open; a closed picker must not
  // re-derive every chain on every keystroke in the amount field.
  const groups = open ? derivePickerGroups({ networks, tokensFor, search, selectedTokenId, balances }) : [];
  const rowCount = groups.reduce((total, group) => total + group.rows.length, 0);

  const moveFocus = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...(listRef.current?.querySelectorAll("[data-picker-row]") ?? [])];
    if (!rows.length) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement);
    rows[rovingIndex(index, rows.length, event.key)]?.focus();
  };

  return (
    <Modal open={open} onClose={onClose} title="Select an asset" size="sm" class="compose-picker">
      <label class="compose-picker__search">
        <span class="sr-only">Search assets and chains</span>
        <input
          type="search"
          value={search}
          placeholder="Search token or chain"
          autoComplete="off"
          spellcheck={false}
          onInput={(event) => setSearch(event.currentTarget.value)}
          onKeyDown={moveFocus}
        />
      </label>

      <div class="compose-picker__list" ref={listRef} onKeyDown={moveFocus}>
        {groups.map((group) => (
          <section class="compose-picker__group" key={group.id} aria-label={group.network.name}>
            <p class="compose-picker__group-head">
              <span>{group.network.name}</span>
              {group.available ? null : <StatePill tone="warning">No route yet</StatePill>}
            </p>
            {group.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                data-picker-row
                class={`compose-picker__row${row.selected ? " is-selected" : ""}${row.disabled ? " is-unavailable" : ""}`}
                aria-disabled={row.disabled ? "true" : undefined}
                aria-current={row.selected ? "true" : undefined}
                aria-label={[
                  `${row.symbol} on ${group.network.name}`,
                  row.balance ? `balance ${row.balance.full}` : null,
                  row.disabled ? `unavailable — ${row.reasons.map((reason) => reason.text).join("; ")}` : null,
                ].filter(Boolean).join(" · ")}
                onClick={() => { if (!row.disabled) onSelect?.(group.network, row); }}
              >
                <TokenGlyph symbol={row.symbol} icon={row.icon ?? null} chainLabel={group.network.name} chainIcon={group.network.icon ?? null} />
                <span class="compose-picker__copy">
                  <span class="compose-picker__symbol">{row.symbol}</span>
                  <span class="compose-picker__name">{row.name}{row.providerLabel ? ` · ${row.providerLabel}` : ""}</span>
                  {row.disabled
                    ? (
                      <span class="compose-picker__reasons">
                        {row.reasons.map((reason) => (
                          <span key={reason.code}>{reason.text}</span>
                        ))}
                      </span>
                    )
                    : null}
                </span>
                <span class="compose-picker__balance tabular no-clip" title={row.balance?.title}>
                  {row.balance ? row.balance.display : ""}
                </span>
              </button>
            ))}
          </section>
        ))}
        {rowCount === 0
          ? <p class="compose-picker__empty">No asset matches “{search}”. Every discovered asset stays listed, including the ones without a route yet.</p>
          : null}
      </div>
    </Modal>
  );
}
