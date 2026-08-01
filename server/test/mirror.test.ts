import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult } from "viem";
import { quoterAbi } from "../src/abi.js";
import { Mirror, retryAfterMilliseconds } from "../src/mirror.js";

const publicMirror = "https://mainnet.mirrornode.hedera.com";
const quoteMirror = "https://dedicated-mirror.example/credential-redacted";
const rpc = "https://mainnet.hashio.io/api";
const quoter = "0x00000000000000000000000000000000003c4370" as const;
const quoteFrom = "0xa6b86f80418e4748c22901c910791d6961486dc9" as const;
const path = "0x0000000000000000000000000000000000163b5a0001f4000000000000000000000000000000000006f89a" as const;
const result = encodeFunctionResult({
  abi: quoterAbi,
  functionName: "quoteExactOutput",
  result: [123n, [1n], [2], 456n],
});

function success() {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Mirror contract-call quote path", () => {
  it("uses an explicit HTTPS quote endpoint override when configured", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => success());
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, { fetch: fetchMock as typeof fetch });
    await expect(mirror.quoteExactOutput(quoter, path, 500_000_000n, quoteFrom)).resolves.toEqual({
      amountIn: 123n,
      gasEstimate: 456n,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${quoteMirror}/api/v1/contracts/call`);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: "eth_call",
      block: "latest",
      to: quoter,
      from: quoteFrom,
      estimate: false,
      gas: 10_000_000,
      gasPrice: 100_000_000,
      value: 0,
    });
  });

  it("serializes concurrent simulations and enforces inter-call spacing", async () => {
    vi.stubEnv("SAUCERSWAP_QUOTE_SPACING_MS", "50");
    let clock = 1_000;
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return success();
    });
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, {
      fetch: fetchMock as typeof fetch,
      sleep,
      now: () => clock,
    });
    await Promise.all([
      mirror.quoteExactOutput(quoter, path, 1n),
      mirror.quoteExactOutput(quoter, path, 2n),
    ]);
    expect(maximumActive).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("measures spacing start-to-start and doubles it for the rest of a burst after any 429", async () => {
    vi.stubEnv("SAUCERSWAP_QUOTE_SPACING_MS", "50");
    vi.stubEnv("MIRROR_QUOTE_429_MAX_ATTEMPTS", "2");
    vi.stubEnv("MIRROR_QUOTE_429_BASE_BACKOFF_MS", "50");
    vi.stubEnv("MIRROR_QUOTE_429_JITTER_MS", "0");
    let clock = 1_000;
    const fetchMock = vi.fn(async () => success())
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }));
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, {
      fetch: fetchMock as typeof fetch,
      sleep,
      random: () => 0,
      now: () => clock,
    });
    // call 1 starts at 1000, sees a 429, backs off 50ms, retries at 1050.
    await mirror.quoteExactOutput(quoter, path, 1n);
    // the in-slot retry re-anchors spacing: call 2 starts 100ms after 1050, not after 1000.
    await mirror.quoteExactOutput(quoter, path, 2n);
    // still within the burst: call 3 waits the full doubled start-to-start gap.
    await mirror.quoteExactOutput(quoter, path, 3n);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([50, 100, 100]);
    // an idle gap ends the burst and restores the configured spacing.
    clock += 1_000;
    await mirror.quoteExactOutput(quoter, path, 4n);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("uses the public Mirror contract-call endpoint when explicitly selected", async () => {
    const fetchMock = vi.fn(async () => success());
    const mirror = new Mirror(publicMirror, rpc, publicMirror, { fetch: fetchMock as typeof fetch });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).resolves.toMatchObject({ amountIn: 123n });
    expect(fetchMock).toHaveBeenCalledWith(
      `${publicMirror}/api/v1/contracts/call`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("defaults quote simulations to the public Mirror endpoint", async () => {
    const fetchMock = vi.fn(async () => success());
    const mirror = new Mirror(publicMirror, rpc, null, { fetch: fetchMock as typeof fetch });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).resolves.toMatchObject({ amountIn: 123n });
    expect(mirror.quoteSimulationIdentity()).toBe(publicMirror);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors Retry-After and performs at most one bounded 429 retry", async () => {
    vi.stubEnv("MIRROR_QUOTE_429_MAX_ATTEMPTS", "2");
    vi.stubEnv("MIRROR_QUOTE_429_BASE_BACKOFF_MS", "500");
    vi.stubEnv("MIRROR_QUOTE_429_MAX_BACKOFF_MS", "10000");
    vi.stubEnv("MIRROR_QUOTE_429_JITTER_MS", "250");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(success());
    const sleep = vi.fn(async () => undefined);
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, {
      fetch: fetchMock as typeof fetch,
      sleep,
      random: () => 0,
    });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).resolves.toMatchObject({ amountIn: 123n });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("hard-stops without retrying when Retry-After exceeds the backoff ceiling", async () => {
    vi.stubEnv("MIRROR_QUOTE_429_MAX_ATTEMPTS", "2");
    vi.stubEnv("MIRROR_QUOTE_429_MAX_BACKOFF_MS", "10000");
    vi.stubEnv("MIRROR_QUOTE_429_JITTER_MS", "250");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "999" } }));
    const sleep = vi.fn(async () => undefined);
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, {
      fetch: fetchMock as typeof fetch,
      sleep,
      random: () => 1,
    });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).rejects.toMatchObject({
      code: "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("hard-stops after the second bounded 429 without a third request", async () => {
    vi.stubEnv("MIRROR_QUOTE_429_MAX_ATTEMPTS", "2");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "0.1" } }));
    const sleep = vi.fn(async () => undefined);
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, {
      fetch: fetchMock as typeof fetch,
      sleep,
      random: () => 0,
    });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).rejects.toMatchObject({
      code: "QUOTE_MIRROR_429_ARCHITECTURE_HARD_STOP",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("never retries a non-429 quote failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error_message: "CONTRACT_REVERT_EXECUTED" }), { status: 400 }));
    const sleep = vi.fn(async () => undefined);
    const mirror = new Mirror(publicMirror, rpc, quoteMirror, { fetch: fetchMock as typeof fetch, sleep });
    await expect(mirror.quoteExactOutput(quoter, path, 1n)).rejects.toThrow("CONTRACT_REVERT_EXECUTED");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("parses both Retry-After forms without producing a negative delay", () => {
    expect(retryAfterMilliseconds("3", 1_000)).toBe(3_000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:00 GMT", 1_000)).toBe(0);
    expect(retryAfterMilliseconds("invalid", 1_000)).toBeNull();
  });

  it("returns only successful positive credits for the expected account and HTS token after submission", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({
      transactions: [
        {
          consensus_timestamp: "1785022901.893723365",
          name: "CRYPTOTRANSFER",
          result: "SUCCESS",
          transaction_hash: "Vz0zVke0Ccb96x4N8v5XRgOTzrwoyiPhktDXnJR836RlJhxFhbve22X8fBZspgVN",
          transaction_id: "0.0.6319439-1785022894-997522183",
          token_transfers: [
            { token_id: "0.0.10285486", account: "0.0.10285485", amount: -3000000 },
            { token_id: "0.0.10285486", account: "0.0.1001", amount: 3000000 },
            { token_id: "0.0.999", account: "0.0.1001", amount: 9000000 },
          ],
        },
        {
          consensus_timestamp: "1785022902.000000001",
          name: "CRYPTOTRANSFER",
          result: "FAIL_INVALID",
          transaction_hash: "ignored",
          transaction_id: "0.0.1-1-1",
          token_transfers: [{ token_id: "0.0.10285486", account: "0.0.1001", amount: 3000000 }],
        },
      ],
    }), { status: 200 }));
    const mirror = new Mirror(publicMirror, rpc, null, { fetch: fetchMock as typeof fetch });
    await expect(mirror.tokenCreditsAfter({
      accountId: "0.0.1001",
      tokenId: "0.0.10285486",
      consensusTimestamp: "1785022894.000000000",
    })).resolves.toEqual([{
      transactionId: "0.0.6319439-1785022894-997522183",
      transactionHash: "Vz0zVke0Ccb96x4N8v5XRgOTzrwoyiPhktDXnJR836RlJhxFhbve22X8fBZspgVN",
      consensusTimestamp: "1785022901.893723365",
      tokenId: "0.0.10285486",
      accountId: "0.0.1001",
      amount: 3000000n,
    }]);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("account.id=0.0.1001");
    expect(calledUrl).toContain("transactiontype=CRYPTOTRANSFER");
    expect(calledUrl).toContain("timestamp=gt%3A1785022894.000000000");
    expect(calledUrl).toContain("order=asc");
  });
});
