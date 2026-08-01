import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSaucerApiCredential } from "../../scripts/lib/load-saucer-secret.js";

afterEach(() => vi.unstubAllEnvs());

describe("Saucer API secret alias loader", () => {
  it("maps the host general secret into the Refuel process contract without changing the value", () => {
    vi.stubEnv("SAUCERSWAP_API_KEY", "");
    vi.stubEnv("SAUCERSWAP_PUBLIC_API_KEY", "fixture-public-secret");
    expect(loadSaucerApiCredential()).toBe("SAUCERSWAP_PUBLIC_API_KEY_alias");
    expect(process.env.SAUCERSWAP_API_KEY).toBe("fixture-public-secret");
  });

  it("prefers an explicitly injected Refuel runtime secret", () => {
    vi.stubEnv("SAUCERSWAP_API_KEY", "runtime-secret");
    vi.stubEnv("SAUCERSWAP_PUBLIC_API_KEY", "general-secret");
    expect(loadSaucerApiCredential()).toBe("SAUCERSWAP_API_KEY");
    expect(process.env.SAUCERSWAP_API_KEY).toBe("runtime-secret");
  });
});
