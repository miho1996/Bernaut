// Same scoring formula as the frontend (index.html → metrics/score).
// Lives on the server too, so AI reviews are built from our own data, not from what a client sends.

const clamp = (v, a = 0, b = 10) => Math.max(a, Math.min(b, v));

// Wash trading: same few wallets buying and selling back and forth.
// Unique traders per trade — 1.0 is fully organic, near 0 is a handful of bots.
export function organic(t) {
  const trades = (t.buys || 0) + (t.sells || 0);
  if (t.traders == null || trades < 10) return 6;
  return clamp((t.traders / trades) * 25);
}
export const isWashed = (t) => t.traders != null && t.buys + t.sells >= 40 && t.traders <= 6;

export function metrics(t) {
  const bs = t.buys / Math.max(1, t.sells);
  const mc = Math.max(1, t.mcap);
  return [
    ["Liquidity / MC", clamp((t.liq / mc) * 40), 1.2],
    ["Top-10 concentration", clamp(10 - (t.top10 - 15) / 6), 1.4],
    ["Dev holdings", clamp(10 - t.dev * 0.8), 1.3],
    ["Snipers", clamp(10 - t.snipers / 2.5), 1.1],
    ["Holders", clamp(Math.log10(Math.max(1, t.holders)) * 3.2 - 2), 1],
    ["Buy pressure", clamp(bs * 5), 1.1],
    ["Volume / MC", clamp((t.vol24 / mc) * 6), 0.9],
    ["Bonding curve", t.graduated ? 8 : clamp(t.progress / 10), 0.8],
    ["Token age", clamp(t.ageMin < 30 ? 3 : t.ageMin < 360 ? 7 : t.ageMin < 4320 ? 9 : 6), 0.5],
    ["Socials", (t.socials.x ? 4 : 0) + (t.socials.tg ? 3 : 0) + (t.socials.web ? 3 : 0), 0.6],
    ["Dev history", t.devPrev === 0 ? 6 : clamp(10 - (t.devRugs / t.devPrev) * 12), 1.3],
    ["LP lock", t.graduated ? (t.lpBurned ? 10 : 1) : 6, 0.8],
    ["Organic activity", organic(t), 1.2],
  ];
}

export function score(t) {
  let s = 0, w = 0;
  for (const [, v, k] of metrics(t)) { s += v * k; w += k; }
  let sc = Math.round((s / w) * 10);
  if (t.devRugs >= 2) sc = Math.min(sc, 38);
  if (t.graduated && !t.lpBurned) sc = Math.min(sc, 44);
  if (isWashed(t)) sc = Math.min(sc, 40);
  return sc;
}

export const verdictOf = (sc) => (sc >= 66 ? "enter" : sc >= 46 ? "wait" : "avoid");

export function fage(m) {
  return m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : m < 43200 ? Math.floor(m / 1440) + "d" : Math.floor(m / 43200) + "mo";
}
