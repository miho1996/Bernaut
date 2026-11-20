// AI-обзор токена через Anthropic Messages API.
// Метрики берутся из индексатора на сервере, клиент присылает только адрес токена,
// поэтому эндпоинт нельзя использовать как бесплатный прокси к модели.

import { metrics, score, verdictOf, fage } from "./scoring.js";

export function payload(t) {
  const sc = score(t);
  return {
    ticker: t.ticker,
    name: t.name,
    chain: "Robinhood Chain",
    launchpad: "Pons",
    age: fage(t.ageMin),
    market_cap_usd: Math.round(t.mcap),
    liquidity_usd: Math.round(t.liq),
    volume_24h_usd: Math.round(t.vol24),
    holders: t.holders,
    top10_holders_pct: t.top10,
    dev_holding_pct: t.dev,
    snipers_pct: t.snipers,
    buys_24h: t.buys,
    sells_24h: t.sells,
    bonding_curve_progress_pct: t.progress,
    graduated: t.graduated,
    lp_locked: t.lpBurned,
    dev_previous_launches: t.devPrev,
    dev_previous_rugs: t.devRugs,
    socials: { x: !!t.socials.x, tg: !!t.socials.tg, web: !!t.socials.web },
    price_change_1h_pct: +t.chg.toFixed(1),
    bernaut_metric_scores: Object.fromEntries(metrics(t).map(([k, v]) => [k, +v.toFixed(1)])),
    bernaut_total_score: sc,
    bernaut_verdict: verdictOf(sc),
  };
}

export function buildPrompt(t) {
  return `Ты — Pronoia, аналитик мемкоинов с лаунчпада Pons (Robinhood Chain). Тебе дают метрики одного токена. Оцени его как опытный on-chain трейдер: ликвидность, концентрацию холдеров, долю дева и снайперов, давление покупок, объём, прогресс бондинг-кривой, историю дева (rug), соцсети, лок LP.
Ответь ТОЛЬКО валидным JSON без markdown, на русском:
{"verdict":"enter"|"wait"|"avoid","confidence":0-100,"summary":"2-3 предложения, главный вывод","pros":["до 4 пунктов с цифрами"],"risks":["до 4 пунктов с цифрами"],"entry":"где/как входить","stop":"стоп-лосс","target":"цель","size":"доля депозита"}
Метрики токена:
${JSON.stringify(payload(t), null, 1)}`;
}

export function parseReview(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no JSON in model output");
  const j = JSON.parse(text.slice(s, e + 1));
  if (!["enter", "wait", "avoid"].includes(j.verdict)) j.verdict = "wait";
  return j;
}

export async function generateReview(t, { apiKey, model, fetchImpl = globalThis.fetch }) {
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: buildPrompt(t) }] }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`Anthropic API ${r.status}: ${body.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return parseReview(text);
}
