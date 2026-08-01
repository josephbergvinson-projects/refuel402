import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = fs.readFileSync(path.join(root, "contracts", "Refuel402ExactPermit2Proxy.sol"), "utf8");
const deployments = JSON.parse(fs.readFileSync(path.join(root, "contracts", "deployments.json"), "utf8"));

describe("Refuel402ExactPermit2Proxy source contract", () => {
  it("binds exact payment identity, Permit2 spender, witness, nonce, deadline, chain, and recipient", () => {
    for (const token of [
      "PAYMENT_TYPEHASH",
      "WITNESS_TYPE_STRING",
      "payment.payer",
      "payment.token",
      "payment.amount",
      "payment.recipient",
      "payment.chainId",
      "payment.nonce",
      "payment.deadline",
      "payment.spender",
      "payment.contextHash",
      "permitWitnessTransferFrom",
      "payment.spender != address(this)",
      "payment.chainId != block.chainid",
      "permit.nonce != payment.nonce",
      "permit.deadline != payment.deadline",
    ]) expect(source).toContain(token);
  });

  it("enforces facilitator-only access, one-time replay protection, reentrancy control, and proof events", () => {
    expect(source).toMatch(/modifier onlyFacilitator\(\)/);
    expect(source).toMatch(/modifier nonReentrant\(\)/);
    expect(source).toContain("consumedPayments[id] = true");
    expect(source.indexOf("consumedPayments[id] = true")).toBeLessThan(source.indexOf("permit2.permitWitnessTransferFrom"));
    expect(source).toContain("event ExactPaymentSettled");
    expect(source).toContain("PaymentAlreadyConsumed");
  });

  it("binds one pre-authorized refuel to cap, exact HBAR, route, deadline, refund, and replay semantics", () => {
    for (const token of [
      "REFUEL_AUTHORIZATION_TYPEHASH",
      "REFUEL_WITNESS_TYPE_STRING",
      "REFUEL_ROUTE_TYPEHASH",
      "authorization.maxAmountIn",
      "authorization.exactHbarTinybar",
      "authorization.serviceFeeAmount",
      "authorization.journeyNonce",
      "authorization.deadline",
      "authorization.routeHash",
      "refuelRouteHash(route)",
      "consumedRefuelAuthorizations[id] = true",
      "permit2.permitWitnessTransferFrom",
      "tradeAmountIn > tradeAmountInMaximum",
      "result.spent > authorization.maxAmountIn",
      // Conservation, not absolute zero: an absolute-zero assertion let anyone
      // brick every future refuel with a 1-unit transfer to the proxy, which has
      // no sweep or rescue.
      "_pullRefuelAuthorization(baseline.token, authorization, permit, signature)",
      "tokenBalanceAfterPull - tokenBalanceBaseline != authorization.maxAmountIn",
      "wrappedBalance - htsBalanceBaseline",
      "_requireBalancesRestored(authorization.token, route.htsToken, baseline)",
      "delivered < authorization.exactHbarTinybar",
      "ExactHbarDeliveryMismatch",
      "event RefuelExecuted",
    ]) expect(source).toContain(token);
    expect(source.indexOf("consumedRefuelAuthorizations[id] = true"))
      .toBeLessThan(source.indexOf("_pullRefuelAuthorization(baseline.token, authorization, permit, signature)"));
    expect(source).toContain("authorization.recipient != authorization.owner");
    expect(source).toContain("refundWeth + leftoverHts * route.wrapperRate");
  });

  it("binds one-shot atomic refuel cap, output, fee, deadline, route, refund, and zero-dust semantics", () => {
    for (const token of [
      "REFUEL_AUTHORIZATION_TYPEHASH",
      "REFUEL_WITNESS_TYPE_STRING",
      "authorization.owner",
      "authorization.token",
      "authorization.maxAmountIn",
      "authorization.exactHbarTinybar",
      "authorization.serviceFeeAmount",
      "authorization.recipient",
      "authorization.journeyNonce",
      "authorization.deadline",
      "authorization.routeHash",
      "consumedRefuelAuthorizations[id] = true",
      "permitWitnessTransferFrom",
      "exactOutput",
      "unwrapWHBAR",
      "RefuelExecuted",
      "TokenDustRetained",
    ]) expect(source).toContain(token);
    expect(source.indexOf("consumedRefuelAuthorizations[id] = true")).toBeLessThan(
      source.indexOf("_pullRefuelAuthorization(baseline.token, authorization, permit, signature)"),
    );
  });

  // An exact-output swap only reveals its input after it fills, so the unspent
  // remainder of what was wrapped comes back as the HTS counterpart. Refunding
  // that as-is repaid the owner in a second token; it is unwrapped first now.
  it("records the verified current-source deployments and preserves superseded history", () => {
    expect(deployments.schema).toBe("refuel402.contract-deployments.v1");
    const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
    expect(deployments.sourceSha256).toBe(sourceSha256);
    expect(deployments.pendingSourceSha256).toBe(sourceSha256);
    expect(deployments.sourceCommit).toBeNull();
    expect(deployments.networks.testnet).toMatchObject({
      chainId: 296,
      proxy: "0xDC1E48E6b365487514447A66dA20E8b8B58a26C3",
      proxyState: "deployed_verified",
      deployedSourceSha256: "c50c4d93171dcf95de6d97cc55f3cebb8145d13be95cd6c65a7161dab8378a83",
      deployedSourceState: "deployed_verified_no_qualifying_testnet_route",
      facilitator: "0xfe231dF050cd0Dc7820BafBF1c2686540b36986e",
      create2Factory: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
      initCodeHash: "0x52916f3f499d3e2b48c291a4ddf884140cfdb5f33b1de49e81044b35977292bb",
      runtimeBytecodeHash: "0x26097d72d7ea4b29f82a8004f66c887c2f0565259acf6bf9a2b089502c07b146",
      deploymentTransactionHash: "0x6358cd541ecdf3bdc4d3110cd40412cee515a70737c4f53bf1d8fd536b2e0c1e",
      deploymentBlockNumber: "38678847",
      deploymentGasUsed: "2375868",
      deploymentFeeHbar: "2.969835",
      deploymentReceiptStatus: "SUCCESS",
      previousProxy: "0x1DC02ac9c62B101844069C82A495207e44e583E2",
      previousProxyDeploymentTransactionHash: "0xf91d29b2df2302f1e077be57ae72dd9ed1aecba52944282f2358b06dd9cecd69",
      refuelAuthorizationProofState: "completed_on_superseded_proxy",
      // Two generations back now, and deliberately not moved forward: this
      // records where the proof actually ran, not the latest thing deployed.
      refuelAuthorizationProofProxy: "0x1DC02ac9c62B101844069C82A495207e44e583E2",
      currentSourceRefuelAuthorizationProofState: "not_executed",
    });
    expect(deployments.networks.testnet.supersededDeployments.map((entry: any) => entry.proxy)).toEqual([
      "0xC9e3778a7df07bBe4b233727f36e3d24b6947561",
      "0x1DC02ac9c62B101844069C82A495207e44e583E2",
      "0x43f3339Be73F2e374f81bAB740c5e6C3DE2B5E3a",
    ]);
    expect(deployments.networks.mainnet).toMatchObject({
      chainId: 295,
      permit2State: "deployed_verified",
      permit2: "0x71304d9943C9d46A18cB6238759800320540F0e4",
      permit2RuntimeBytecodeHash: "0x8f8e4ed20cd41ad7b63198fd698b3f7c43de34d09dbef6c6e6fd56dec7678747",
      permit2DeploymentTransactionHash: "0xe954b76226ff1a52d8446abe1293b051c282889ee36bc9ce2be6e9d2bd041188",
      proxyState: "deployed_verified",
      deployedSourceSha256: "c50c4d93171dcf95de6d97cc55f3cebb8145d13be95cd6c65a7161dab8378a83",
      deployedSourceState: "deployed_verified_refuel_authorization_executed",
      proxy: "0x91d81fbAf684482a9db0195C0d8d5bDc4880b2b4",
      initCodeHash: "0x12dfcf3836c28a8df2606aebaadd4447104a4ce0b0b367a09e8905af3bd06fb6",
      runtimeBytecodeHash: "0x76704f4d7553e3c29c19d81d9a1e6a4ece9d1e80e3d7ffd1082ba778545719d8",
      deploymentTransactionHash: "0xbd5ba5a4d6d1dec89c53b65da298c1449dfd2509bdc6395b07f330bcbc61b6aa",
      deploymentBlockNumber: "98336623",
      deploymentGasUsed: "2375904",
      deploymentFeeHbar: "2.96988",
      deploymentReceiptStatus: "SUCCESS",
      facilitator: "0xe4838e2c43bd074424fb74e49e004f82a8fe4f4a",
      facilitatorAccountId: "0.0.10758833",
      facilitatorMaxAutomaticTokenAssociations: -1,
      facilitatorAccountUpdateTransactionId: "0.0.10758833@1785502692.848359166",
      facilitatorAccountUpdateReceiptStatus: "SUCCESS",
      facilitatorAccountUpdateChargedFeeHbar: "0.00323275",
    });
    expect(deployments.networks.mainnet.supersededDeployments.map((entry: any) => entry.proxy)).toEqual([
      "0x64460b9c6Db566b0C28daf5e86945A1Fa3088667",
      "0x8d888825FFEe3f875A596aDd4c94680326CbeD5A",
      "0x32D40276F1ddBA900223198f99324a480EC2d005",
    ]);
    expect(deployments.liveDeploymentAuthorized).toBe(false);
    expect(deployments.note).toContain("has not been deployed");
    expect(deployments.note).toContain("No current-bytecode testnet whole-product proof is claimed");
    expect(deployments.compiler).toMatchObject({ version: "0.8.28", optimizer: true, runs: 200 });
  });
});
