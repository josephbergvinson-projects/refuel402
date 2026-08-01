import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import express from "express";
import type { Network } from "@x402/core/types";
import type { LifecycleStore } from "./postgres-store.js";

export function requestClientIp(req: express.Request): string {
  const railwayHeaderTrusted =
    !!process.env.RAILWAY_ENVIRONMENT_ID ||
    !!process.env.RAILWAY_PROJECT_ID ||
    process.env.TRUST_REAL_IP_HEADER === "1";
  const railwayRealIp = req.header("x-real-ip")?.trim();
  if (railwayHeaderTrusted && railwayRealIp && isIP(railwayRealIp)) return railwayRealIp;
  const socketIp = req.ip || req.socket.remoteAddress || "unknown";
  return socketIp.startsWith("::ffff:") ? socketIp.slice(7) : socketIp;
}

export type OperationalReadiness = {
  network: Network;
  executable: boolean;
  lifecycleStore: "postgres" | "local-json";
  checkFacilitator: () => Promise<boolean>;
};

export function installHttpBoundary(app: express.Express): void {
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : false);
  app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.slice(0, 128) || randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  const browserOrigins = new Set(
    (process.env.FRONTEND_ORIGINS ?? "https://refuel402.pages.dev")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && browserOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Payment-Signature, X-Payment, Idempotency-Key, X-Request-Id",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      if (!origin || !browserOrigins.has(origin)) return res.status(403).end();
      return res.status(204).end();
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "frame-src 'none'; img-src 'self' data: https:; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
}

export function registerOperationalRoutes(
  app: express.Express,
  store: LifecycleStore,
  readiness: OperationalReadiness,
): void {
  app.get("/livez", (_req, res) => {
    res.json({ ok: true, service: "Refuel402", time: new Date().toISOString() });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await store.healthcheck?.();
      if (!(await readiness.checkFacilitator())) {
        return res.status(503).json({
          code: "FACILITATOR_UNAVAILABLE",
          message: "facilitator is unavailable",
          retriable: true,
          requestId: res.locals.requestId ?? null,
        });
      }
      return res.json({
        ok: true,
        service: "Refuel402",
        network: readiness.network,
        executable: readiness.executable,
        lifecycleStore: readiness.lifecycleStore,
        time: new Date().toISOString(),
      });
    } catch {
      return res.status(503).json({
        code: "DEPENDENCY_UNAVAILABLE",
        message: "a required dependency is unavailable",
        retriable: true,
        requestId: res.locals.requestId ?? null,
      });
    }
  });
}
