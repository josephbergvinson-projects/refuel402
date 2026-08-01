import { AmountInput, Chip, ChipGroup, StatePill } from "../ui/index.js";

const DEFAULT_OPTIONS = [
  { id: "flexible", label: "Flexible" },
  { id: "balanced", label: "Balanced" },
  { id: "strict", label: "Strict" },
];

export function PriceProtectionRow({
  model,
  preset = "flexible",
  customCap = "",
  symbol = "asset",
  disabled = false,
  onPreset,
  onCustomCap,
}) {
  // No hard `if (!model) return null` — every model-dependent block below is
  // already guarded individually, and the row must survive the invalidation its
  // own controls cause. Without a model it renders as what it is: a setting,
  // with the priced consequences filled in once a quote binds them.
  const options = model?.options?.length ? model.options : DEFAULT_OPTIONS;
  const showCustom = preset === "custom";
  return (
    <section class="price-protection" aria-label="Refuel price protection">
      <div class="price-protection__head">
        <div>
          <p class="price-protection__title">Refuel price protection</p>
          <p class="price-protection__caption">Converts when your funds land.</p>
        </div>
        {model ? <StatePill tone={model.warning ? "warning" : "brand"}>{(model.bufferBps / 100).toFixed(2)}% buffer</StatePill> : null}
      </div>

      <ChipGroup label="Price protection preset">
        {options.map((option) => (
          <Chip
            key={option.id}
            selected={preset === option.id}
            disabled={disabled}
            onSelect={() => onPreset?.(option.id)}
            title={option.maximum ? `Maximum ${option.maximum.title}` : undefined}
          >
            {option.label}
          </Chip>
        ))}
        <Chip selected={showCustom} disabled={disabled} onSelect={() => onPreset?.("custom")}>Custom</Chip>
      </ChipGroup>

      {showCustom
        ? (
          <div class="price-protection__custom">
            <AmountInput
              value={customCap}
              onInput={onCustomCap}
              size="sm"
              align="right"
              label={`Custom maximum ${symbol} spend`}
              suffix={symbol}
              disabled={disabled}
              placeholder="0"
            />
            {/* Named up front, because a cap under today's price is refused. */}
            {model
              ? <p class="price-protection__hint">Must be at least {model.today.amount} — today’s price.</p>
              : null}
          </div>
        )
        : null}

      {model
        ? (
          <dl class="price-protection__amounts">
            <div>
              <dt>Today’s price</dt>
              <dd>{model.today.amount}{model.today.usd ? ` · ${model.today.usd}` : ""}</dd>
            </div>
            <div>
              <dt>Your cap</dt>
              <dd>{model.cap.amount}{model.cap.usd ? ` · ${model.cap.usd}` : ""} <span>— never spends more than this</span></dd>
            </div>
          </dl>
        )
        : <p class="price-protection__hint" role="status">Get a quote to price this cap. Your selection is kept.</p>}

      <p class="price-protection__explanation">
        {model?.explanation ?? "If the price is better you spend less — anything unused stays in your wallet. If it moves past your cap nothing is spent."}
      </p>
      {model?.warning ? <p class="price-protection__warning" role="status">{model.warning}</p> : null}
    </section>
  );
}
