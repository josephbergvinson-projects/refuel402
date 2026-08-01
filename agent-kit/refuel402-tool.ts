import { BaseTool, type Context, type Plugin } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { z } from "zod";

export const refuel402FuelParameters = z.object({
  tokenId: z.string().regex(/^\d+\.\d+\.\d+$/),
  desiredHbar: z.string().regex(/^\d+(\.\d{1,8})?$/),
  minimumRetained: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  slippageBps: z.number().int().min(0).max(300).default(100),
});

export type Refuel402FuelParams = z.input<typeof refuel402FuelParameters>;
export type NormalizedRefuel402FuelParams = z.output<typeof refuel402FuelParameters>;

export type Refuel402AgentExecutor = (
  params: NormalizedRefuel402FuelParams,
  context: Context,
  client: Client,
) => Promise<unknown>;

/**
 * Hedera Agent Kit v4 tool for the public Refuel402 lifecycle.
 *
 * Credential custody is supplied by the operator-controlled agent runtime via
 * the executor. The tool itself never reads, logs, or transmits a private key.
 */
export class Refuel402FuelTool extends BaseTool<
  Refuel402FuelParams,
  NormalizedRefuel402FuelParams
> {
  method = "refuel402_fuel";
  name = "Refuel402 Fuel";
  description =
    "Receive exact native HBAR from a supported HTS balance through a policy-bound x402-paid sponsorship.";
  parameters = refuel402FuelParameters;

  constructor(private readonly executor: Refuel402AgentExecutor) {
    super();
  }

  async normalizeParams(
    params: Refuel402FuelParams,
    context: Context,
    _client: Client,
  ): Promise<NormalizedRefuel402FuelParams> {
    if (!context.accountId) throw new Error("Agent Kit context.accountId is required");
    const normalized = this.parameters.parse(params);
    const desired = Number(normalized.desiredHbar);
    if (!Number.isFinite(desired) || desired <= 0 || desired > 1) {
      throw new Error("desiredHbar must be above 0 and at most 1 HBAR for the bounded testnet tool");
    }
    return normalized;
  }

  async coreAction(
    normalized: NormalizedRefuel402FuelParams,
    context: Context,
    client: Client,
  ): Promise<unknown> {
    return this.executor(normalized, context, client);
  }

  async shouldSecondaryAction(): Promise<boolean> {
    // Refuel402Agent performs the x402 settlement and sponsored execution as
    // one externally reconciled lifecycle. Agent Kit must not submit a second
    // Hedera transaction after the core action returns.
    return false;
  }

  async secondaryAction(request: unknown): Promise<unknown> {
    return request;
  }
}

export function createRefuel402Plugin(executor: Refuel402AgentExecutor): Plugin {
  return {
    name: "refuel402",
    version: "0.1.0",
    description: "Legacy destination-only Hedera refuel action; the human product uses the same-wallet EVM x402 flow",
    tools: () => [new Refuel402FuelTool(executor)],
  };
}
