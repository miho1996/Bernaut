// Token review via the Anthropic Messages API.
// Metrics come from our own indexer; the client only sends a token address,
// so the endpoint can't be used as a free proxy to the model.

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
    unique_traders_24h: t.traders ?? null,
    bonding_curve_progress_pct: t.progress,
    graduated: t.graduated,
    lp_locked: t.lpBurned,
    dev_previous_launches: t.devPrev,
    dev_previous_rugs: t.devRugs,
    socials: { x: !!t.socials.x, tg: !!t.socials.tg, web: !!t.socials.web },
    price_change_1h_pct: +t.chg.toFixed(1),
    elenchos_metric_scores: Object.fromEntries(metrics(t).map(([k, v]) => [k, +v.toFixed(1)])),
    elenchos_total_score: sc,
    elenchos_verdict: verdictOf(sc),
  };
}

export function buildPrompt(t) {
  return `You are Elenchos, an analyst for memecoins launched on the Pons launchpad (Robinhood Chain). You get the on-chain metrics of one token. Judge it like an experienced on-chain trader: liquidity, holder concentration, dev and sniper share, buy pressure, volume, bonding-curve progress, dev history (rugs), socials, LP lock, and whether the volume is organic (unique traders vs trades — few wallets doing many trades means wash trading).
Reply with ONLY valid JSON, no markdown, in English:
{"verdict":"enter"|"wait"|"avoid","confidence":0-100,"summary":"2-3 sentences, the main takeaway","pros":["up to 4 points with numbers"],"risks":["up to 4 points with numbers"],"entry":"where/how to enter","stop":"stop-loss","target":"take-profit target","size":"share of portfolio"}
Token metrics:
${JSON.stringify(payload(t), null, 1)}`;
}

export function parseReview(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no JSON in model output");
  const j = JSON.parse(text.slice(s, e + 1));
  if (!["enter", "wait", "avoid"].includes(j.verdict)) j.verdict = "wait";
  return j;
}

// Провайдер AI: OpenRouter (OPENROUTER_API_KEY) или напрямую Anthropic (ANTHROPIC_API_KEY).
export function aiConfig(env = process.env) {
  if (env.OPENROUTER_API_KEY) return { provider: "openrouter", apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5", siteUrl: env.SITE_URL || "" };
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5" };
  return null;
}

export async function generateReview(t, { provider = "anthropic", apiKey, model, siteUrl = "", fetchImpl = globalThis.fetch }) {
  const prompt = buildPrompt(t);
  const isOR = provider === "openrouter";
  const r = await fetchImpl(isOR ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: isOR
      ? { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "X-Title": "Elenchos", ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}) }
      : { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    const err = new Error(`${isOR ? "OpenRouter" : "Anthropic"} API ${r.status}: ${body.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  const text = isOR
    ? String(j.choices?.[0]?.message?.content ?? "")
    : (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return parseReview(text);
}
