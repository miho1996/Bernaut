// Pronoia backend: индексатор Pons + API + AI-обзор + раздача сайта.
//
//   GET  /                     → index.html
//   GET  /api/status           → состояние синхронизации
//   GET  /api/listings         → массив токенов в формате фронтенда
//   GET  /api/token/:address   → один токен
//   POST /api/review/:address  → AI-обзор (JSON)

import http from "node:http";
import zlib from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PonsIndexer, defaultConfig } from "./indexer.js";
import { generateReview, aiConfig } from "./review.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createApp({ indexer, env = process.env, fetchImpl = globalThis.fetch }) {
  const ai = aiConfig(env);
  const apiKey = ai?.apiKey;
  const reviewTtl = +(env.REVIEW_CACHE_SEC ?? 300) * 1000;
  const perMin = +(env.REVIEW_RATE_PER_MIN ?? 6);
  const allowOrigin = env.CORS_ORIGIN || "*";
  const reviews = new Map(); // address → { at, data }
  const hits = new Map(); // ip → [timestamps]
  let listCache = { at: 0, body: null };
  const imgCache = new Map(); // url → { type, buf }

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

  // Прокси логотипов: только https/http картинки до 2 МБ, без внутренних адресов, кэш в памяти.
  // IPFS: перебираем несколько шлюзов; тип картинки определяем по содержимому (шлюзы часто отдают octet-stream).
  const GATEWAYS = ["https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://w3s.link/ipfs/"];
  const sniff = (b) => {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
    if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
    if (b.subarray(4, 12).toString().startsWith("ftypavif")) return "image/avif";
    const head = b.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
    if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
    return null;
  };
  const okHost = (t) => /^https?:$/.test(t.protocol) && !/^(localhost|.*\.local|.*\.internal)$/i.test(t.hostname) && !/^[\d.]+$/.test(t.hostname) && !t.hostname.includes(":");
  async function fetchImage(href) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetchImpl(href, { signal: ctl.signal, redirect: "follow", headers: { accept: "image/*,*/*;q=0.5", "user-agent": "Mozilla/5.0 Pronoia" } });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) return null;
      const type = sniff(buf);
      return type ? { type, buf } : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  const pending = new Map(); // url → Promise (одна загрузка на URL)
  function parseImgUrl(u) {
    let target;
    try { target = new URL(u); } catch { return null; }
    return okHost(target) ? target.href : null;
  }
  async function loadImage(key) {
    if (imgCache.has(key)) return imgCache.get(key);
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        const m = key.match(/\/ipfs\/(.+)$/);
        const tries = m ? GATEWAYS.map((g) => g + m[1]) : [key];
        let hit = null;
        for (const h of tries) { hit = await fetchImage(h); if (hit) break; }
        imgCache.set(key, hit); // null тоже кэшируем, чтобы не долбить мёртвые ссылки
        if (imgCache.size > 1500) imgCache.delete(imgCache.keys().next().value);
        pending.delete(key);
        return hit;
      })());
    }
    return pending.get(key);
  }
  async function proxyImage(u, res) {
    const key = parseImgUrl(u);
    if (!key) return send(res, 400, { error: "bad url" });
    const hit = await loadImage(key);
    if (!hit) return send(res, 404, { error: "no image" }, { "cache-control": "public, max-age=600" });
    res.writeHead(200, { "content-type": hit.type, "cache-control": "public, max-age=604800, immutable", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff", "access-control-allow-origin": allowOrigin });
    res.end(hit.buf);
  }

  // Сжатие: brotli, если браузер умеет, иначе gzip
  const pack = (body) => ({ raw: Buffer.from(body), br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }), gz: zlib.gzipSync(body, { level: 6 }) });
  function sendPacked(req, res, packed, type, extra = {}) {
    const ae = String(req.headers["accept-encoding"] || "");
    const [enc, buf] = /\bbr\b/.test(ae) ? ["br", packed.br] : /gzip/.test(ae) ? ["gzip", packed.gz] : [null, packed.raw];
    res.writeHead(200, { "content-type": type, "access-control-allow-origin": allowOrigin, vary: "accept-encoding", ...(enc ? { "content-encoding": enc } : {}), ...extra });
    res.end(buf);
  }
  function listingsPacked() {
    if (!indexer) return null;
    if (Date.now() - listCache.at > 2000 || !listCache.packed) {
      const json = JSON.stringify({ status: indexer.status(), tokens: indexer.listings() });
      listCache = { at: Date.now(), json, packed: pack(json), html: null };
    }
    return listCache;
  }
  const pages = new Map();
  async function staticPage(name) {
    if (!pages.has(name) || env.NODE_ENV === "development") pages.set(name, pack(await readFile(path.join(ROOT, "pages", name + ".html"), "utf8")));
    return pages.get(name);
  }
  // Страница с уже вшитыми листингами — рисуется сразу, без второго запроса
  let tpl = null;
  async function pagePacked() {
    if (!tpl || env.NODE_ENV === "development") tpl = await readFile(path.join(ROOT, "index.html"), "utf8");
    const lc = listingsPacked();
    if (!lc) return pack(tpl);
    if (!lc.html || lc.htmlTpl !== tpl) {
      const boot = `<script>window.__BOOT__=${lc.json.replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "")}</script>`;
      lc.html = pack(tpl.replace("<!--BOOT-->", boot));
      lc.htmlTpl = tpl;
    }
    return lc.html;
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (p === "/" || p === "/index.html") return sendPacked(req, res, await pagePacked(), "text/html; charset=utf-8", { "cache-control": "no-cache" });
      if (p === "/healthz") return send(res, 200, { ok: true });
      if (p === "/privacy" || p === "/terms") return sendPacked(req, res, await staticPage(p.slice(1)), "text/html; charset=utf-8", { "cache-control": "public, max-age=300" });
      if (p === "/img") return proxyImage(url.searchParams.get("u"), res);
      if (p === "/api/status") return send(res, 200, { ...(indexer?.status() ?? { synced: false, disabled: true }), ai: !!apiKey, aiProvider: ai?.provider ?? null });
      if (!indexer) return send(res, 503, { error: "indexer disabled: set RPC_URL" });

      if (p === "/api/listings") return sendPacked(req, res, listingsPacked().packed, "application/json; charset=utf-8", { "cache-control": "no-store" });
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
        const data = await generateReview(t, { ...ai, fetchImpl });
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
  // индексатор зовёт это, как только узнаёт логотип нового токена
  handler.warm = (u) => { const k = parseImgUrl(u); if (k) loadImage(k).catch(() => {}); };
  return handler;
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
  const app = createApp({ indexer });
  if (indexer) indexer.onLogo = (u) => app.warm(u);
  http.createServer(app).listen(port, () => console.log(`Pronoia on :${port}`));
}
