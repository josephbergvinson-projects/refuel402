import { describe, expect, it } from "vitest";
import { getAddress, pad } from "viem";
import { hasLayerZeroDirectRouteForAsset, normalizeLayerZeroScanStatus, quoteLayerZeroDirect } from "../src/layerzero-oft.js";

const destinationHash = `0x${"cd".repeat(32)}`;

describe("LayerZero direct OFT quote and status", () => {
  it("verifies bidirectional peers and builds the exact OFT send transaction", async () => {
    const sourceToken = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
    const sourceAdapter = getAddress("0x0555e30da8f98308edb960aa94c0db47230d2b9c");
    const destinationOft = getAddress("0xD7D4d91d64a6061fA00a94E2b3A2D2A5FB677849");
    const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const source = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "peers") return pad(destinationOft, { size: 32 });
        if (functionName === "token") return sourceToken;
        if (functionName === "approvalRequired") return true;
        if (functionName === "quoteSend") return { nativeFee: 75_000_000_000_000n, lzTokenFee: 0n };
        if (functionName === "quoteOFT") return [
          { minAmountLD: 0n, maxAmountLD: 2n ** 64n - 1n },
          [],
          { amountSentLD: 10_000n, amountReceivedLD: 10_000n },
        ];
        throw new Error(`unexpected source call ${functionName}`);
      },
    };
    const destination = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "peers") return pad(sourceAdapter, { size: 32 });
        throw new Error(`unexpected destination call ${functionName}`);
      },
    };
    const quote = await quoteLayerZeroDirect({
      mode: "mainnet",
      originChainId: "1",
      originToken: sourceToken,
      destinationToken: destinationOft,
      account,
      amount: 10_000n,
      slippageBps: 100,
    }, { source, destination });
    expect(quote).toMatchObject({
      sourceAdapter,
      expectedDestinationAmount: "10000",
      minimumDestinationAmount: "9900",
      nativeFee: "75000000000000",
      approvalRequired: true,
    });
    expect(quote!.quoteId).toMatch(/^direct-oft-[0-9a-f]{64}$/);
    expect(quote!.transactionData.slice(0, 10)).toBe("0xc7c7f5b3");
  });

  it("uses the official USDT0 adapter/OFT peers while preserving the Hedera HTS destination token", async () => {
    const sourceToken = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    const sourceAdapter = getAddress("0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee");
    const destinationOft = getAddress("0xe3119e23fc2371d1e6b01775ba312035425a53d6");
    const destinationToken = getAddress("0x00000000000000000000000000000000009ce723");
    const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const source = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "peers") return pad(destinationOft, { size: 32 });
        if (functionName === "token") return sourceToken;
        if (functionName === "approvalRequired") return true;
        if (functionName === "quoteSend") return { nativeFee: 50_000_000_000_000n, lzTokenFee: 0n };
        if (functionName === "quoteOFT") return [
          { minAmountLD: 1n, maxAmountLD: 1_000_000_000n },
          [],
          { amountSentLD: 10_000_000n, amountReceivedLD: 9_997_000n },
        ];
        throw new Error(`unexpected source call ${functionName}`);
      },
    };
    const destination = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "peers") return pad(sourceAdapter, { size: 32 });
        throw new Error(`unexpected destination call ${functionName}`);
      },
    };
    const quote = await quoteLayerZeroDirect({
      mode: "mainnet",
      originChainId: "1",
      originToken: sourceToken,
      destinationToken,
      account,
      amount: 10_000_000n,
      slippageBps: 100,
    }, { source, destination });
    expect(quote).toMatchObject({
      sourceAdapter,
      expectedDestinationAmount: "9997000",
      minimumDestinationAmount: "9900000",
      approvalRequired: true,
      evidence: { route: "ethereum-usdt-to-hedera-usdt0-oft-v3", destinationOft },
    });
  });

  it("verifies the permissionless native ETH Stargate pool/OFT route and includes principal plus messaging fee in value", async () => {
    const sourcePool = getAddress("0x77b2043768d28E9C9aB44E1aBfC95944bcE57931");
    const sourceMessaging = getAddress("0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980");
    const destinationStargate = getAddress("0xda6087E69C51E7D31b6DBAD276a3c44703DFdCAd");
    const destinationMessaging = getAddress("0x8a2B28364102Bea189D99A475C494330Ef2bDD0B");
    const destinationToken = getAddress("0xCa367694CDaC8f152e33683BB36CC9d6A73F1ef2");
    const nativeMarker = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    const account = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const source = {
      getCode: async () => "0x1234" as const,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === sourceMessaging.toLowerCase() && functionName === "peers") return pad(destinationMessaging, { size: 32 });
        if (functionName === "token") return getAddress("0x0000000000000000000000000000000000000000");
        if (functionName === "localEid") return 30101;
        if (functionName === "sharedDecimals") return 6;
        if (functionName === "stargateType") return 0;
        if (functionName === "paths") return 2n ** 64n - 1n;
        if (functionName === "getAddressConfig") return { tokenMessaging: sourceMessaging };
        if (functionName === "quoteSend") return { nativeFee: 75_000_000_000_000n, lzTokenFee: 0n };
        if (functionName === "quoteOFT") return [
          { minAmountLD: 1_000_000_000_000n, maxAmountLD: 2n ** 255n },
          [],
          { amountSentLD: 1_000_000_000_000_000n, amountReceivedLD: 1_000_000_000_000_000n },
        ];
        throw new Error(`unexpected source call ${address} ${functionName}`);
      },
    };
    const destination = {
      getCode: async () => "0x1234" as const,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        if (address.toLowerCase() === destinationMessaging.toLowerCase() && functionName === "peers") return pad(sourceMessaging, { size: 32 });
        if (functionName === "token") return destinationToken;
        if (functionName === "localEid") return 30316;
        if (functionName === "sharedDecimals") return 6;
        if (functionName === "stargateType") return 1;
        if (functionName === "paths") return 1_000_000n;
        if (functionName === "getAddressConfig") return { tokenMessaging: destinationMessaging };
        throw new Error(`unexpected destination call ${address} ${functionName}`);
      },
    };
    const quote = await quoteLayerZeroDirect({
      mode: "mainnet",
      originChainId: "1",
      originToken: nativeMarker,
      destinationToken,
      account,
      amount: 1_000_000_000_000_000n,
      slippageBps: 100,
    }, { source, destination });
    expect(hasLayerZeroDirectRouteForAsset({
      mode: "mainnet",
      originTokens: [{ chainId: "1", address: nativeMarker }],
      destinationToken,
    })).toBe(true);
    expect(quote).toMatchObject({
      source: "stargate-v2-taxi",
      sourceAdapter: sourcePool,
      expectedDestinationAmount: "1000000000000000",
      minimumDestinationAmount: "1000000000000000",
      nativeFee: "75000000000000",
      transactionValue: "1075000000000000",
      approvalRequired: false,
      nativeSource: true,
    });
    expect(quote!.quoteId).toMatch(/^direct-stargate-[0-9a-f]{64}$/);
    expect(quote!.transactionData.slice(0, 10)).toBe("0xc7c7f5b3");
  });

  it("treats indexing delay as pending rather than an unknown terminal result", () => {
    expect(normalizeLayerZeroScanStatus({ data: [] })).toEqual({
      state: "pending",
      providerStatus: "not_found",
      destinationTransactionHash: null,
    });
  });

  it("requires both delivered message and successful destination execution", () => {
    expect(normalizeLayerZeroScanStatus({
      data: [{
        status: { name: "DELIVERED" },
        destination: { status: "SUCCEEDED", tx: { txHash: destinationHash } },
      }],
    })).toEqual({
      state: "arrived",
      providerStatus: "delivered",
      destinationTransactionHash: destinationHash,
    });
    expect(normalizeLayerZeroScanStatus({
      data: [{ status: { name: "CONFIRMING" }, destination: { status: "VALIDATING_TX" } }],
    }).state).toBe("pending");
  });

  it("fails closed on blocked, failed, or stored payloads", () => {
    expect(normalizeLayerZeroScanStatus({
      data: [{ status: { name: "BLOCKED" }, destination: { status: "WAITING" } }],
    }).state).toBe("failed");
    expect(normalizeLayerZeroScanStatus({
      data: [{ status: { name: "DELIVERED" }, destination: { status: "SIMULATION_REVERTED" } }],
    }).state).toBe("failed");
  });
});
