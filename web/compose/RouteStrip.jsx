import { Disclosure, StatePill } from "../ui/index.js";
import { formatUsd } from "../compose-view-model.js";

/**
 * THE quote disclosure — there is exactly one on this surface. Collapsed it names
 * the two legs, the ETA, and what the route costs in both denominations; expanded
 * it holds every fee, the sponsored-gas line, max slippage and the fair-value
 * check. Evidence is relocated here, never deleted.
 */
export function RouteStrip({ route, blockers = [], open, onToggle }) {
  if (!route.available) return null;
  return (
    <Disclosure
      class="compose-route"
      open={open}
      onToggle={onToggle}
      summary={(
        <span class="compose-route__summary">
          {/* Legs on their own line as discrete pills: one run-on
              "Stargate V2 Fast / LayerZero → SaucerSwap V2 · ETA pending" broke
              across lines mid-provider-name and read as a single mangled word. */}
          <span class="compose-route__legs">
            {route.legs.map((leg, index) => (
              <span class="compose-route__leg" key={leg}>
                {index ? <span class="compose-route__arrow" aria-hidden="true">→</span> : null}
                <span>{leg}</span>
              </span>
            ))}
            <StatePill tone={route.etaSeconds ? "neutral" : "warning"} hint={route.etaSeconds ? "Provider estimate; arrival is confirmed from chain evidence." : "The provider has not published an estimate for this route yet."}>
              {route.eta}
            </StatePill>
          </span>
          <span class="compose-route__cost">
            <span class="compose-route__cost-label">{route.total.label}</span>
            <span class="compose-route__total tabular no-clip" title={route.total.title}>{route.total.text}</span>
          </span>
        </span>
      )}
    >
      {route.hops.length
        ? (
          <div class="compose-route__hops scroll-x" role="list" aria-label="Route hops">
            {route.hops.map((hop, index) => (
              <span class="compose-route__slot" role="listitem" key={hop.id}>
                {index ? <span class="compose-route__arrow" aria-hidden="true">→</span> : null}
                <span class="compose-route__hop" title={hop.title}>
                  {hop.label}
                  {hop.note ? <i>{hop.note}</i> : null}
                </span>
              </span>
            ))}
          </div>
        )
        : null}

      <dl class="compose-route__rows">
        {route.rows.map((row) => (
          <div class="compose-route__row" key={row.id} title={row.title || undefined}>
            <dt>{row.label}</dt>
            <dd class={`tabular no-clip compose-route__value--${row.tone}`}>{row.value}</dd>
          </div>
        ))}
      </dl>

      {blockers.length
        ? (
          <ul class="compose-route__blockers" aria-label="Why this route is paused">
            {blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.text}</li>
            ))}
          </ul>
        )
        : null}

      {/* The policy essay that used to sit here — mixed-venue support, liquidity
          floors, price-impact gates, the quote id and its expiry timestamp — was
          four lines of internal policy on a surface where the reader is deciding
          an amount. Every one of those gates is enforced whether or not it is
          recited, the liquidity figure is a hop title in the route above, and the
          expiry is the countdown under the CTA. Route liquidity that actually
          BLOCKS the quote still appears, in the blockers list above. */}
      {route.liquidityUsd === null || route.liquidityUsd === undefined
        ? null
        : (
          <p class="compose-route__evidence">
            Least liquid pool on this route: {formatUsd(route.liquidityUsd)}.
          </p>
        )}
    </Disclosure>
  );
}
