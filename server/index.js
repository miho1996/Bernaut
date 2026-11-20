// Pronoia backend: индексатор Pons + API + AI-обзор + раздача сайта.
//
//   GET  /                     → index.html
//   GET  /api/status           → состояние синхронизации
//   GET  /api/listings         → массив токенов в формате фронтенда
//   GET  /api/token/:address   → один токен
//   POST /api/review/:address  → AI-обзор (JSON)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PonsIndexer, defaultConfig } from "./indexer.js";
import { generateReview } from "./review.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createApp({ indexer, env = process.env, fetchImpl = globalThis.fetch }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const reviewTtl = +(env.REVIEW_CACHE_SEC ?? 300) * 1000;
  const perMin = +(env.REVIEW_RATE_PER_MIN ?? 6);
  const allowOrigin = env.CORS_ORIGIN || "*";
  const reviews = new Map(); // address → { at, data }
  const hits = new Map(); // ip → [timestamps]
  let listCache = { at: 0, body: null };

  const send = (res, code, obj, extra = {}) => {
    const body = typeof obj === "string" ? obj : JSON.stringify(obj);
    res.writeHead(code, { "content-type": typeof obj === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8", "access-control-allow-origin": allowOrigin, "access-control-allow-headers": "content-type", ...extra });
    res.end(body);
  };
  const limited = (ip) => {
    const now = Date.now();
    const a = (hits.get(ip) || []).filter((x) => now - x < 60000);
    a.push(now);
    hits.set(ip, a);
    if (hits.size > 10000) hits.clear();
    return a.length > perMin;
  };

  return async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (p === "/" || p === "/index.html") {
        return send(res, 200, await readFile(path.join(ROOT, "index.html"), "utf8"), { "cache-control": "no-cache" });
      }
      if (p === "/healthz") return send(res, 200, { ok: true });
      if (p === "/api/status") return send(res, 200, { ...(indexer?.status() ?? { synced: false, disabled: true }), ai: !!apiKey });
      if (!indexer) return send(res, 503, { error: "indexer disabled: set RPC_URL" });

      if (p === "/api/listings") {
        if (Date.now() - listCache.at > 2000) listCache = { at: Date.now(), body: JSON.stringify({ status: indexer.status(), tokens: indexer.listings() }) };
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": allowOrigin, "cache-control": "no-store" });
        return res.end(listCache.body);
      }
      let m;
      if ((m = p.match(/^\/api\/token\/(0x[0-9a-fA-F]{40})$/))) {
        const t = indexer.get(m[1]);
        return t ? send(res, 200, t) : send(res, 404, { error: "not found" });
      }
      if ((m = p.match(/^\/api\/review\/(0x[0-9a-fA-F]{40})$/)) && req.method === "POST") {
        if (!apiKey) return send(res, 503, { error: "ai_disabled" });
        const addr = m[1].toLowerCase();
        const t = indexer.get(addr);
        if (!t) return send(res, 404, { error: "not found" });
        const c = reviews.get(addr);
        if (c && Date.now() - c.at < reviewTtl) return send(res, 200, { ...c.data, cached: true });
        const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        if (limited(ip)) return send(res, 429, { error: "rate_limited" });
        const data = await generateReview(t, { apiKey, model, fetchImpl });
        reviews.set(addr, { at: Date.now(), data });
        if (reviews.size > 2000) reviews.delete(reviews.keys().next().value);
        return send(res, 200, data);
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error("[http]", p, e.message);
      return send(res, e.status === 429 ? 429 : 500, { error: e.status === 429 ? "rate_limited" : "internal" });
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = defaultConfig();
  let indexer = null;
  if (cfg.rpcUrl) {
    indexer = new PonsIndexer(cfg);
    (async function boot() {
      for (;;) {
        try { await indexer.start(); return; } catch (e) { console.error("[pons] start failed, retry in 10s:", e.message); }
        await new Promise((r) => setTimeout(r, 10000));
      }
    })();
  } else {
    console.warn("[pons] RPC_URL не задан — индексатор выключен, сайт покажет демо-данные");
  }
  const port = +(process.env.PORT || 8080);
  http.createServer(createApp({ indexer })).listen(port, () => console.log(`Pronoia on :${port}`));
}
