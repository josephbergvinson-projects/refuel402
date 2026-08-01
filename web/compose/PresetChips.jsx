import { Chip, ChipGroup } from "../ui/index.js";
import { matchesPreset } from "../compose-view-model.js";

/**
 * Preset amounts. Every chip is the same kind of control and is labelled with the
 * amount it applies — including the last one, the server-published ceiling.
 *
 * The ceiling chip carries one extra behaviour: choosing it also asks the server
 * to re-solve the exact maximum for this route, so the field lands on the real
 * bound rather than on the configured cap. That is why it can report "Solving…",
 * and why no chip above a known maximum is ever disabled: the meter and the
 * server's own constraint explain the limit better than a dead control does.
 */
export function PresetChips({ presets, value, onSelect, onMax, disabled = false, solving = false }) {
  return (
    <ChipGroup label="Preset HBAR amounts" class="compose-presets">
      {presets.chips.map((chip) => {
        const ceiling = chip.kind === "bound";
        return (
          <Chip
            key={chip.id}
            /* No brand tone on the ceiling chip: it read as "selected" or
               "recommended" while sitting beside the actually-selected one, so
               two chips looked chosen at once. Every chip is the same control;
               only `selected` says which one is in force. */
            selected={matchesPreset(chip.hbar, value)}
            disabled={disabled || (ceiling && solving)}
            hint={chip.hint}
            class={chip.exceedsMaximum ? "compose-presets__over" : undefined}
            onSelect={() => (ceiling ? onMax?.() : onSelect?.(chip.hbar))}
          >
            {ceiling && solving ? "Solving…" : chip.label}
          </Chip>
        );
      })}
    </ChipGroup>
  );
}
