import { Meter } from "../ui/index.js";

/**
 * How much of the arriving amount the refuel spends, against the server-solved
 * maximum. An impossible request reads as an overflow carrying the server's own
 * limiting constraint — never as a raw 422.
 */
export function FeasibilityMeter({ feasibility }) {
  if (!feasibility.applicable) return null;
  return (
    <div class="compose-meter">
      <Meter
        label={feasibility.caption}
        limitLabel={feasibility.limitCaption}
        value={feasibility.value}
        max={feasibility.max}
        valueText={feasibility.valueText}
        overflowNote={feasibility.overflowNote}
        tone={feasibility.known ? "brand" : "neutral"}
        hint={feasibility.resolution
          ? `Conservative unresolved interval ${feasibility.resolution.full} HBAR`
          : undefined}
      />
    </div>
  );
}
