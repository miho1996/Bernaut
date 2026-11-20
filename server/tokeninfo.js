// Разбор ответа getTokenInfo() на токене Pons.
// Точная структура ответа в публичной документации не описана (известно только, что там
// deployer, logo, description и соцсети: Twitter, Telegram, Discord, website, Farcaster).
// Поэтому вызываем метод «сырым» eth_call и вытаскиваем из ABI-ответа все строки,
// а потом раскладываем их по смыслу. Это переживёт изменение порядка полей в структуре.

import { decodeAbiParameters, parseAbiParameters } from "viem";

export const GET_TOKEN_INFO_SELECTOR = "0xabb1dc44"; // keccak256("getTokenInfo()")[0..4], проверяется в тестах

const printable = (s) => s.length > 0 && !/[\u0000-\u0008\u000e-\u001f]/.test(s);

export function extractAbiStrings(hex) {
  if (!hex || hex === "0x") return [];
  const buf = Buffer.from(hex.slice(2), "hex");
  const words = Math.floor(buf.length / 32);
  const word = (pos) => (pos + 32 <= buf.length ? BigInt("0x" + buf.subarray(pos, pos + 32).toString("hex")) : null);
  const found = new Map();
  // Указатели на строки бывают относительно начала данных и относительно начала кортежа (обычно 0x20).
  const bases = new Set([0]);
  const first = word(0);
  if (first !== null && first % 32n === 0n && first < BigInt(buf.length)) bases.add(Number(first));
  for (const base of bases) {
    for (let i = 0; i < words; i++) {
      const w = word(base + i * 32);
      if (w === null || w === 0n || w % 32n !== 0n) continue;
      const off = base + Number(w);
      if (off + 32 > buf.length) continue;
      const len = word(off);
      if (len === null || len === 0n || len > 4096n) continue;
      const end = off + 32 + Number(len);
      if (end > buf.length) continue;
      const s = buf.subarray(off + 32, end).toString("utf8");
      if (printable(s) && !s.includes("�")) found.set(off, s.trim());
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s).filter(Boolean);
}

export function normalizeUri(u) {
  if (!u) return null;
  if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.slice(7).replace(/^ipfs\//, "");
  if (u.startsWith("ar://")) return "https://arweave.net/" + u.slice(5);
  return u;
}

export function classifyStrings(strings) {
  const out = { logo: null, description: null, socials: { x: null, tg: null, discord: null, web: null, farcaster: null } };
  const isUrl = (s) => /^(https?:\/\/|ipfs:\/\/|ar:\/\/|www\.)/i.test(s) || /^[\w-]+\.[a-z]{2,}(\/|$)/i.test(s);
  for (const s of strings) {
    const l = s.toLowerCase();
    if (/^(ipfs|ar):\/\//.test(l) || /\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(l) || /(ipfs\.io|arweave\.net|pinata|nftstorage|\/ipfs\/)/.test(l)) {
      out.logo ??= normalizeUri(s);
    } else if (/(twitter\.com|x\.com)\//.test(l) || /^@\w+$/.test(s)) {
      out.socials.x ??= s;
    } else if (/(t\.me|telegram\.(me|org))\//.test(l)) {
      out.socials.tg ??= s;
    } else if (/discord\.(gg|com)/.test(l)) {
      out.socials.discord ??= s;
    } else if (/(warpcast\.com|farcaster)/.test(l)) {
      out.socials.farcaster ??= s;
    } else if (isUrl(s)) {
      out.socials.web ??= s;
    } else if (!out.description || s.length > out.description.length) {
      out.description = s;
    }
  }
  return out;
}

// Pons V2: getTokenInfo() → (address deployer, string logo, string description,
//   (string twitter, string telegram, string discord, string website, string farcaster) socials)
const V2_INFO = parseAbiParameters("address, string, string, (string, string, string, string, string)");

export function parseTokenInfo(hex) {
  try {
    const [, logo, description, so] = decodeAbiParameters(V2_INFO, hex);
    const s = Array.isArray(so) ? so : Object.values(so);
    const v = (x) => (x && String(x).trim()) || null;
    return {
      logo: normalizeUri(v(logo)),
      description: v(description),
      socials: { x: v(s[0]), tg: v(s[1]), discord: v(s[2]), web: v(s[3]), farcaster: v(s[4]) },
    };
  } catch {
    // неизвестная раскладка → эвристика по всем строкам ответа
    return classifyStrings(extractAbiStrings(hex));
  }
}
