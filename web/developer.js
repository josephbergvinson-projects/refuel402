import { MetaMaskController } from "./wallet.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/developer.css";

const $ = (selector) => document.querySelector(selector);
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const endpoint = (path) => API_BASE ? `${API_BASE}${path}` : path;
const STATIC = import.meta.env.VITE_STATIC_READ_ONLY === "1";

document.querySelectorAll("[data-api-path]").forEach((link) => {
  link.href = endpoint(link.dataset.apiPath);
});

async function readJson(path) {
  const response = await fetch(endpoint(path), { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `${path} returned ${response.status}`);
  return body;
}

async function probe() {
  if (STATIC && !API_BASE) {
    $("#apiState").textContent = "Static";
    $("#healthValue").textContent = "No backend";
    $("#executionValue").textContent = "Disabled";
    $("#networkValue").textContent = "Static UI";
    $("#tokenValue").textContent = "Live API required";
    return;
  }
  try {
    const [health, options, rpc] = await Promise.all([
      readJson("/v1/health"),
      readJson("/v1/product/options?mode=testnet"),
      readJson("/v1/product/policy-rpc"),
    ]);
    $("#apiState").textContent = "Reachable";
    $("#healthValue").textContent = health.ok ? "Healthy" : "Degraded";
    $("#executionValue").textContent = options.capabilities.execution ? "Enabled" : "Fail closed";
    $("#networkValue").textContent = `${options.hedera.name} · ${options.hedera.chainId}`;
    $("#tokenValue").textContent = `${options.assets.length} candidate${options.assets.length === 1 ? "" : "s"} · ${rpc.writeEnabled ? "write" : "read-only"} RPC`;
  } catch (error) {
    $("#apiState").textContent = "Unavailable";
    $("#healthValue").textContent = error.message;
    $("#executionValue").textContent = "Disabled";
  }
}

$("#inspectAccount").addEventListener("click", async () => {
  const id = $("#accountInput").value.trim();
  if (!/^(\d+\.\d+\.\d+|0x[0-9a-fA-F]{40})$/.test(id)) {
    $("#accountOutput").textContent = "Enter a valid 0.0.x account or 0x EVM address.";
    return;
  }
  try {
    const result = await readJson(`/v1/account/${encodeURIComponent(id)}?network=testnet`);
    $("#accountOutput").textContent = JSON.stringify({
      exists: result.exists,
      accountState: result.accountState,
      account: result.account,
      evmAddress: result.evmAddress,
      hbarTinybar: result.hbarTinybar,
      fuelableHoldings: result.tokens?.filter((token) => token.fuelable) ?? [],
      hashscan: result.hashscan,
    }, null, 2);
  } catch (error) {
    $("#accountOutput").textContent = error.message;
  }
});

const metamask = new MetaMaskController();
metamask.subscribe((snapshot) => {
  $("#metamaskState").textContent = snapshot.connected
    ? `${snapshot.account} · chain ${snapshot.chainId} · stock EIP-1193`
    : "Disconnected";
  $("#metamaskButton").textContent = snapshot.connected ? "MetaMask connected" : "Connect MetaMask";
  $("#metamaskButton").disabled = snapshot.connected;
});

$("#metamaskButton").addEventListener("click", async () => {
  try { await metamask.connect(); }
  catch (error) { $("#metamaskState").textContent = error.message; }
});

await metamask.restore().catch(() => undefined);
await probe();
