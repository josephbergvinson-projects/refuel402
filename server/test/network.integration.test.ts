import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let child: ChildProcess;
let base = "";
let dataDir = "";

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      const selected = address.port;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refuel402-read-api-"));
  const root = path.resolve(import.meta.dirname, "..", "..");
  child = spawn(process.execPath, [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "server", "src", "index.ts"),
  ], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      HEDERA_NETWORK: "testnet",
      SPONSOR_ACCOUNT_ID: "",
      SPONSOR_PRIVATE_KEY: "",
      DEMO_ENABLE: "1",
      DEMO_AUTH_TOKEN: "integration-test-auth-token",
      TRUST_REAL_IP_HEADER: "1",
      PRODUCT_LIFECYCLE_RATE_LIMIT_MAX: "3",
    },
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}`;
  // Cold startup can be slow when the dependency tree lives on external storage,
  // and this spawns a real server while the rest of the suite runs in parallel:
  // measured ~1.6s alone but past 30s when the whole suite competes for I/O.
  // Wait for the asserted health signal rather than a machine-speed assumption.
  for (let i = 0; i < 900; i++) {
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("read-only server did not start");
}, 120_000);

afterAll(() => {
  child?.kill("SIGTERM");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("dual-network read contract", () => {
  it("exposes bounded operational health and exact browser CORS", async () => {
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("x-request-id")).toBeTruthy();
    expect(ready.headers.get("x-powered-by")).toBeNull();
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      executable: false,
      lifecycleStore: process.env.DATABASE_URL ? "postgres" : "local-json",
    });

    const allowed = await fetch(`${base}/v1/refuel/plan`, {
      method: "OPTIONS",
      headers: { origin: "https://refuel402.pages.dev" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://refuel402.pages.dev");

    const denied = await fetch(`${base}/v1/refuel/plan`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
  });

  it("publishes distinct chain contracts and keeps both execution-disabled without a sponsor", async () => {
    const [testnet, mainnet] = await Promise.all([
      fetch(`${base}/v1/policy?network=testnet`).then((r) => r.json()),
      fetch(`${base}/v1/policy?network=mainnet`).then((r) => r.json()),
    ]);
    expect(testnet).toMatchObject({ network: "hedera:testnet", chainId: 296, executable: false });
    expect(mainnet).toMatchObject({ network: "hedera:mainnet", chainId: 295, executable: false });
    expect(testnet.router.evm).not.toBe(mainnet.router.evm);
    expect(testnet.whbar.hedera).not.toBe(mainnet.whbar.hedera);
  });

  it("exposes first-class providers and rejects explicit provider/asset drift", async () => {
    const options = await fetch(`${base}/v1/product/options?mode=testnet`).then((response) => response.json());
    expect(options.providers.map((provider: { id: string }) => provider.id)).toEqual([
      "auto",
      "axelar",
      "layerzero",
    ]);
    const monad = options.networks.find((network: { chainId: string }) => network.chainId === "10143");
    expect(monad.providerOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "axelar" }),
      expect.objectContaining({ id: "layerzero", runtime: expect.objectContaining({ quoteReady: false }) }),
    ]));

    const mismatch = await fetch(`${base}/v1/product/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "testnet",
        account: "0x1111111111111111111111111111111111111111",
        provider: "layerzero",
        assetId: "axelar:testnet:axe",
        originChainId: "10143",
        originToken: "0x1111111111111111111111111111111111111111",
        amountBaseUnits: "1",
        desiredHbar: "5",
        slippageBps: 100,
      }),
    });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({ code: "PROVIDER_ASSET_MISMATCH" });
  });

  it("keeps bridge and whitelist reads network-specific and excludes hashport remnants from fuelable mainnet", async () => {
    const [testnetBridges, mainnetBridges, mainnetWhitelist] = await Promise.all([
      fetch(`${base}/v1/bridges?network=testnet`).then((r) => r.json()),
      fetch(`${base}/v1/bridges?network=mainnet`).then((r) => r.json()),
      fetch(`${base}/v1/whitelist?network=mainnet`).then((r) => r.json()),
    ]);
    expect(testnetBridges).toEqual({});
    expect(mainnetBridges.hashport.live).toBe(false);
    expect(mainnetWhitelist.chainId).toBe(295);
    expect(mainnetWhitelist.tokens.some((token: { bridge?: string }) => token.bridge === "hashport")).toBe(false);
  });

  it("rate-limits the lifecycle surface by validated real client IP", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${base}/v1/product/journeys`, {
        method: "POST",
        headers: { "x-real-ip": "203.0.113.42" },
      });
      statuses.push(response.status);
    }
    const lifecycleStatus = process.env.DATABASE_URL ? 400 : 503;
    expect(statuses).toEqual([lifecycleStatus, lifecycleStatus, lifecycleStatus, 429]);
  });

  it("fails execution closed and returns structured demo/auth errors", async () => {
    const fuel = await fetch(`${base}/v1/fuel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactions: ["0x01"] }),
    });
    expect(fuel.status).toBe(503);
    await expect(fuel.json()).resolves.toMatchObject({
      code: "EXECUTION_DISABLED",
      retriable: false,
    });

    const demo = await fetch(`${base}/v1/demo/run`, { method: "POST" });
    expect(demo.status).toBe(403);
    await expect(demo.json()).resolves.toMatchObject({
      code: "DEMO_AUTH_REQUIRED",
      retriable: false,
    });
  });
});
