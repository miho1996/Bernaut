// Та же формула оценки, что и во фронтенде (index.html → metrics/score).
// Нужна на сервере, чтобы AI-обзор строился из своих данных, а не из того, что прислал клиент.

const clamp = (v, a = 0, b = 10) => Math.max(a, Math.min(b, v));

export function metrics(t) {
  const bs = t.buys / Math.max(1, t.sells);
  const mc = Math.max(1, t.mcap);
  return [
    ["Ликвидность / MC", clamp((t.liq / mc) * 40), 1.2],
    ["Концентрация топ-10", clamp(10 - (t.top10 - 15) / 6), 1.4],
    ["Доля дева", clamp(10 - t.dev * 0.8), 1.3],
    ["Снайперы", clamp(10 - t.snipers / 2.5), 1.1],
    ["Холдеры", clamp(Math.log10(Math.max(1, t.holders)) * 3.2 - 2), 1],
    ["Давление покупок", clamp(bs * 5), 1.1],
    ["Объём / MC", clamp((t.vol24 / mc) * 6), 0.9],
    ["Кривая бондинга", t.graduated ? 8 : clamp(t.progress / 10), 0.8],
    ["Возраст токена", clamp(t.ageMin < 30 ? 3 : t.ageMin < 360 ? 7 : t.ageMin < 4320 ? 9 : 6), 0.5],
    ["Соцсети", (t.socials.x ? 4 : 0) + (t.socials.tg ? 3 : 0) + (t.socials.web ? 3 : 0), 0.6],
    ["История дева", t.devPrev === 0 ? 6 : clamp(10 - (t.devRugs / t.devPrev) * 12), 1.3],
    ["Лок / burn LP", t.graduated ? (t.lpBurned ? 10 : 1) : 6, 0.8],
  ];
}

export function score(t) {
  let s = 0, w = 0;
  for (const [, v, k] of metrics(t)) { s += v * k; w += k; }
  let sc = Math.round((s / w) * 10);
  if (t.devRugs >= 2) sc = Math.min(sc, 38);
  if (t.graduated && !t.lpBurned) sc = Math.min(sc, 44);
  return sc;
}

export const verdictOf = (sc) => (sc >= 66 ? "enter" : sc >= 46 ? "wait" : "avoid");

export function fage(m) {
  return m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : m < 43200 ? Math.floor(m / 1440) + "d" : Math.floor(m / 43200) + "mo";
}
