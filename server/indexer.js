// Индексатор лаунчпада Pons на Robinhood Chain (chain id 4663).
//
// Источник контрактов и событий: Mobula Almanac, «Pons Launchpad Integration on Robinhood Chain».
//  - Фабрики эмитят TokenLaunched(token, deployer, dexFactory, pairToken, pool, ...)
//  - Торговля идёт в пулах Uniswap V3 → читаем их Swap
//  - Прогресс бондинга и graduation: factory.graduationStatus(token)
//  - Метаданные и соцсети: token.getTokenInfo()
//
// Всё хранится в памяти. После рестарта сервис заново догоняет последние BACKFILL_HOURS.

import { createPublicClient, http, parseAbi, parseAbiItem, defineChain, formatUnits } from "viem";
import { GET_TOKEN_INFO_SELECTOR, parseTokenInfo } from "./tokeninfo.js";

export const PONS = {
  chainId: 4663,
  factories: [
    "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", // active
    "0x0c37a24F5D23A486FA692d1500881d698B1F77a4", // legacy
  ],
  lockers: [
    "0x736D76699C26D0d966744cAe304C000d471f7F35",
    "0x31ca5E101941A93A7DD6d0497928700625CF54B5",
  ],
};

const EV_LAUNCH = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
);
const EV_SWAP = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
);
const EV_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const FACTORY_ABI = parseAbi(["function graduationStatus(address token) view returns (uint256 current, uint256 threshold, bool graduated)"]);
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const lc = (a) => a.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400;

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function defaultConfig(env = process.env) {
  return {
    rpcUrl: env.RPC_URL,
    backfillHours: +(env.BACKFILL_HOURS ?? 6),
    pollMs: +(env.POLL_MS ?? 3000),
    refreshMs: +(env.REFRESH_MS ?? 20000),
    logChunk: +(env.LOG_CHUNK ?? 2000),
    sniperBlocks: +(env.SNIPER_BLOCKS ?? 20),
    maxTracked: +(env.MAX_TRACKED ?? 4000),
    listLimit: +(env.LIST_LIMIT ?? 500),
    deadAfterMin: +(env.DEAD_AFTER_MIN ?? 120),
    pairUsd: env.PAIR_USD ? JSON.parse(env.PAIR_USD) : {}, // {"0xpair": 1.0} — ручные цены пар-токенов
    ethUsdFallback: env.ETH_USD ? +env.ETH_USD : null,
  };
}

export class PonsIndexer {
  constructor(cfg, { client, fetchImpl = globalThis.fetch, log = console } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.fetch = fetchImpl;
    this.client =
      client ??
      createPublicClient({
        chain: defineChain({ id: PONS.chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }),
        transport: http(cfg.rpcUrl, { retryCount: 3, timeout: 20000 }),
      });
    this.factories = PONS.factories.map(lc);
    this.excluded = new Set([ZERO, DEAD, ...this.factories, ...PONS.lockers.map(lc)]);
    this.tokens = new Map(); // token → state
    this.pools = new Map(); // pool → token
    this.pairs = new Map(); // pairToken → { symbol, decimals, kind }
    this.deployers = new Map(); // deployer → [{ token, block }]  (не вычищается)
    this.rugged = new Set();
    this.prices = { eth: cfg.ethUsdFallback, btc: null, ts: 0 };
    this.blockTs = new Map();
    this.cursor = null;
    this.head = null;
    this.synced = false;
    this.chunk = cfg.logChunk;
    this.stopped = false;
  }

  // ---------- lifecycle ----------
  async start() {
    await this.updatePrices();
    this.head = await this.client.getBlockNumber();
    const bt = await this.estimateBlockTime(this.head);
    const back = BigInt(Math.ceil((this.cfg.backfillHours * 3600) / bt));
    this.cursor = this.head > back ? this.head - back : 0n;
    this.startBlock = this.cursor;
    this.log.info?.(`[pons] head=${this.head} blockTime≈${bt.toFixed(3)}s backfill from ${this.cursor}`);
    this.scanLoop();
    this.refreshLoop();
    this.priceLoop();
  }
  stop() { this.stopped = true; }

  async estimateBlockTime(head) {
    const span = 20000n;
    const a = await this.ts(head > span ? head - span : 0n);
    const b = await this.ts(head);
    return Math.max(0.05, (b - a) / Number(span > head ? head : span) || 1);
  }

  async ts(block) {
    const k = block.toString();
    if (!this.blockTs.has(k)) {
      const b = await this.client.getBlock({ blockNumber: block });
      this.blockTs.set(k, Number(b.timestamp));
      if (this.blockTs.size > 5000) this.blockTs.delete(this.blockTs.keys().next().value);
    }
    return this.blockTs.get(k);
  }

  async scanLoop() {
    while (!this.stopped) {
      try {
        this.head = await this.client.getBlockNumber();
        if (this.cursor >= this.head) { this.synced = true; await sleep(this.cfg.pollMs); continue; }
        const to = this.cursor + BigInt(this.chunk) < this.head ? this.cursor + BigInt(this.chunk) : this.head;
        await this.scanRange(this.cursor + 1n, to);
        this.cursor = to;
        if (this.chunk < this.cfg.logChunk) this.chunk = Math.min(this.cfg.logChunk, this.chunk * 2);
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e);
        if (/range|too many|limit|exceed|10000|timeout|size/i.test(msg) && this.chunk > 10) {
          this.chunk = Math.max(10, Math.floor(this.chunk / 2));
          this.log.warn?.(`[pons] getLogs failed, chunk → ${this.chunk}: ${msg.slice(0, 160)}`);
        } else {
          this.log.error?.(`[pons] scan error: ${msg.slice(0, 300)}`);
          await sleep(5000);
        }
      }
    }
  }

  async refreshLoop() {
    while (!this.stopped) {
      try { await this.refreshAll(); this.evict(); } catch (e) { this.log.error?.(`[pons] refresh error: ${e?.message}`); }
      await sleep(this.cfg.refreshMs);
    }
  }

  async priceLoop() {
    while (!this.stopped) { await sleep(60000); await this.updatePrices(); }
  }

  async updatePrices() {
    try {
      const r = await this.fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      this.prices = { eth: j.ethereum?.usd ?? this.prices.eth, btc: j.bitcoin?.usd ?? this.prices.btc, ts: Date.now() };
    } catch (e) {
      this.log.warn?.(`[pons] price feed failed: ${e.message}`);
    }
  }

  // ---------- scanning ----------
  async scanRange(from, to) {
    const launches = await this.client.getLogs({ address: PONS.factories, event: EV_LAUNCH, fromBlock: from, toBlock: to });
    await pool(launches, 6, (l) => this.addToken(l));

    const [tsFrom, tsTo] = await Promise.all([this.ts(from), this.ts(to)]);
    const tsOf = (bn) => (to === from ? tsTo : tsFrom + ((tsTo - tsFrom) * Number(bn - from)) / Number(to - from));

    const poolAddrs = [...this.pools.keys()];
    const tokenAddrs = [...this.tokens.keys()];
    const logs = [];
    for (const c of chunks(poolAddrs, 400)) logs.push(...(await this.client.getLogs({ address: c, event: EV_SWAP, fromBlock: from, toBlock: to })));
    for (const c of chunks(tokenAddrs, 400)) logs.push(...(await this.client.getLogs({ address: c, event: EV_TRANSFER, fromBlock: from, toBlock: to })));
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

    for (const l of logs) {
      if (l.eventName === "Swap") this.onSwap(l, tsOf(l.blockNumber));
      else if (l.eventName === "Transfer") this.onTransfer(l, tsOf(l.blockNumber));
    }
  }

  async pairInfo(addr) {
    const a = lc(addr);
    if (!this.pairs.has(a)) {
      const [symbol, decimals] = await Promise.all([
        this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
        this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      ]);
      const s = String(symbol).toUpperCase();
      const kind = /USD/.test(s) ? "usd" : /ETH/.test(s) ? "eth" : /BTC/.test(s) ? "btc" : "unknown";
      this.pairs.set(a, { symbol: String(symbol), decimals: Number(decimals), kind });
    }
    return this.pairs.get(a);
  }

  pairUsd(addr) {
    const a = lc(addr);
    const override = this.cfg.pairUsd[a] ?? this.cfg.pairUsd[addr];
    if (override != null) return +override;
    const p = this.pairs.get(a);
    if (!p) return null;
    return p.kind === "usd" ? 1 : p.kind === "eth" ? this.prices.eth : p.kind === "btc" ? this.prices.btc : null;
  }

  async addToken(l) {
    const a = l.args;
    const token = lc(a.token);
    if (this.tokens.has(token)) return;
    const [pair, name, symbol, decimals, supply, launchTs] = await Promise.all([
      this.pairInfo(a.pairToken),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "name" }).catch(() => ""),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => 0n),
      this.ts(l.blockNumber),
    ]);
    const t = {
      address: token,
      deployer: lc(a.deployer),
      factory: lc(l.address),
      pairToken: lc(a.pairToken),
      pool: lc(a.pool),
      isToken0: token < lc(a.pairToken), // в Uniswap V3 token0 — меньший адрес
      decimals: Number(decimals),
      pairDecimals: pair.decimals,
      supply: Number(formatUnits(supply, Number(decimals))) || 1,
      name: String(name),
      symbol: String(symbol),
      launchBlock: l.blockNumber,
      launchTs,
      balances: new Map(),
      firstBuy: new Map(), // адрес → блок первой покупки
      swaps: [], // { ts, price (в пар-токене), buy, pairAmt }
      lastPrice: 0,
      progress: 0,
      graduated: false,
      pairBal: 0,
      info: null,
      lastActivity: launchTs,
      dirty: true,
      peakMcap: 0,
      devSold: false,
    };
    this.tokens.set(token, t);
    this.pools.set(t.pool, token);
    if (!this.deployers.has(t.deployer)) this.deployers.set(t.deployer, []);
    this.deployers.get(t.deployer).push({ token, block: l.blockNumber });
  }

  priceFromSqrt(t, sqrtPriceX96) {
    const r = Number(sqrtPriceX96) / 2 ** 96;
    const p = r * r; // raw token1 / raw token0
    if (!p) return 0;
    const scale = 10 ** (t.decimals - t.pairDecimals);
    return t.isToken0 ? p * scale : (1 / p) * scale;
  }

  onSwap(l, ts) {
    const t = this.tokens.get(this.pools.get(lc(l.address)));
    if (!t) return;
    const { amount0, amount1, sqrtPriceX96 } = l.args;
    const amtTok = t.isToken0 ? amount0 : amount1;
    const amtPair = t.isToken0 ? amount1 : amount0;
    const price = this.priceFromSqrt(t, sqrtPriceX96);
    const pairAmt = Math.abs(Number(formatUnits(amtPair < 0n ? -amtPair : amtPair, t.pairDecimals)));
    t.swaps.push({ ts, price, buy: amtTok < 0n, pairAmt });
    t.lastPrice = price;
    t.lastActivity = ts;
    t.dirty = true;
    // держим сутки истории + одну точку до окна для графика
    const cutoff = ts - DAY;
    let i = 0;
    while (i < t.swaps.length - 1 && t.swaps[i + 1].ts < cutoff) i++;
    if (i > 0) t.swaps.splice(0, i);
  }

  onTransfer(l, ts) {
    const t = this.tokens.get(lc(l.address));
    if (!t) return;
    const from = lc(l.args.from), to = lc(l.args.to);
    const v = Number(formatUnits(l.args.value, t.decimals));
    if (from !== ZERO) t.balances.set(from, (t.balances.get(from) ?? 0) - v);
    t.balances.set(to, (t.balances.get(to) ?? 0) + v);
    if (from === t.pool && to !== t.pool && !t.firstBuy.has(to)) t.firstBuy.set(to, l.blockNumber);
    if (from === t.deployer && to === t.pool) t.devSold = true;
    t.lastActivity = Math.max(t.lastActivity, ts);
  }

  // ---------- on-chain state ----------
  async refreshAll() {
    const todo = [...this.tokens.values()].filter((t) => t.dirty || !t.info);
    await pool(todo, 8, async (t) => {
      try {
        const [gs, bal, info] = await Promise.all([
          this.client.readContract({ address: t.factory, abi: FACTORY_ABI, functionName: "graduationStatus", args: [t.address] }).catch(() => null),
          this.client.readContract({ address: t.pairToken, abi: ERC20_ABI, functionName: "balanceOf", args: [t.pool] }).catch(() => null),
          t.info ? null : this.client.call({ to: t.address, data: GET_TOKEN_INFO_SELECTOR }).then((r) => parseTokenInfo(r.data)).catch(() => null),
        ]);
        if (gs) {
          const [cur, thr, grad] = gs;
          t.graduated = !!grad;
          t.progress = grad ? 100 : thr > 0n ? Math.max(0, Math.min(100, Math.round(Number((cur * 10000n) / thr) / 100))) : 0;
        }
        if (bal != null) t.pairBal = Number(formatUnits(bal, t.pairDecimals));
        if (info) t.info = info;
        else if (!t.info) t.info = { logo: null, description: null, socials: {} };
        t.dirty = false;
      } catch (e) {
        this.log.warn?.(`[pons] refresh ${t.address}: ${e.message}`);
      }
    });
  }

  evict() {
    const now = Date.now() / 1000;
    const dead = [];
    for (const t of this.tokens.values()) {
      const idle = (now - t.lastActivity) / 60;
      if (!t.graduated && idle > this.cfg.deadAfterMin && t.progress < 10) dead.push(t);
    }
    for (const t of dead) this.drop(t);
    if (this.tokens.size > this.cfg.maxTracked) {
      const rest = [...this.tokens.values()].sort((a, b) => a.lastActivity - b.lastActivity);
      for (const t of rest.slice(0, this.tokens.size - this.cfg.maxTracked)) this.drop(t);
    }
  }
  drop(t) { this.tokens.delete(t.address); this.pools.delete(t.pool); }

  // ---------- projection to frontend shape ----------
  view(t, now = Date.now() / 1000) {
    const pairUsd = this.pairUsd(t.pairToken);
    if (pairUsd == null) return null;
    const price = t.lastPrice * pairUsd;
    const mcap = price * t.supply;

    const holders = [];
    let poolTok = 0;
    for (const [a, b] of t.balances) {
      if (a === t.pool) { poolTok = b; continue; }
      if (b > 1e-9 && !this.excluded.has(a)) holders.push([a, b]);
    }
    holders.sort((x, y) => y[1] - x[1]);
    const pct = (v) => +((v / t.supply) * 100).toFixed(1);
    const top10 = pct(holders.slice(0, 10).reduce((s, [, b]) => s + b, 0));
    const dev = pct(Math.max(0, t.balances.get(t.deployer) ?? 0));
    let sn = 0;
    for (const [a, blk] of t.firstBuy) {
      if (a !== t.deployer && !this.excluded.has(a) && blk - t.launchBlock <= BigInt(this.cfg.sniperBlocks)) sn += Math.max(0, t.balances.get(a) ?? 0);
    }

    const day = t.swaps.filter((s) => s.ts >= now - DAY);
    const buys = day.filter((s) => s.buy).length;
    const sells = day.length - buys;
    const vol24 = day.reduce((s, x) => s + x.pairAmt, 0) * pairUsd;
    const liq = t.pairBal * pairUsd + Math.max(0, poolTok) * price;

    // 40 точек цены за жизнь токена (максимум сутки)
    const span = Math.max(60, Math.min(DAY, now - t.launchTs));
    const start = now - span;
    const pts = [];
    let j = 0, last = t.swaps.find((s) => s.ts >= start)?.price ?? t.lastPrice;
    for (let k = 0; k < 40; k++) {
      const edge = start + (span * (k + 1)) / 40;
      while (j < t.swaps.length && t.swaps[j].ts <= edge) last = t.swaps[j++].price;
      pts.push((last || t.lastPrice || 1) * pairUsd);
    }
    const hourAgo = t.swaps.filter((s) => s.ts <= now - 3600).pop()?.price ?? t.swaps[0]?.price ?? t.lastPrice;
    const chg = hourAgo ? (t.lastPrice / hourAgo - 1) * 100 : 0;

    // история дева: прошлые запуски и «рагпуллы» (дев продал, а MC упал >90% от пика)
    if (mcap > t.peakMcap) t.peakMcap = mcap;
    if (t.devSold && t.peakMcap >= 5000 && mcap < t.peakMcap * 0.1) this.rugged.add(t.address);
    const prev = (this.deployers.get(t.deployer) ?? []).filter((x) => x.block < t.launchBlock);
    const devRugs = prev.filter((x) => this.rugged.has(x.token)).length;

    const s = t.info?.socials ?? {};
    const hue = parseInt(t.address.slice(2, 8), 16) % 360;
    return {
      id: t.address,
      ticker: t.symbol.replace(/^\$/, "").slice(0, 14),
      name: t.name.slice(0, 40) || t.symbol,
      emoji: (t.symbol.match(/\p{Extended_Pictographic}/u) || [t.symbol.replace(/^\$/, "").charAt(0).toUpperCase() || "?"])[0],
      logo: t.info?.logo ?? null,
      description: t.info?.description ?? null,
      hue,
      address: t.address,
      creator: t.deployer,
      chain: "Robinhood",
      pool: t.pool,
      pairSymbol: this.pairs.get(t.pairToken)?.symbol ?? "?",
      graduated: t.graduated,
      progress: t.progress,
      ageMin: Math.max(0, Math.floor((now - t.launchTs) / 60)),
      price,
      mcap,
      holders: holders.length,
      top10,
      dev,
      snipers: pct(sn),
      vol24,
      buys,
      sells,
      liq,
      devPrev: prev.length,
      devRugs,
      socials: { x: s.x ?? null, tg: s.tg ?? null, web: s.web ?? null, discord: s.discord ?? null },
      // Pons отправляет ликвидность выпускника в locker навсегда
      lpBurned: t.graduated ? true : null,
      pts,
      chg,
    };
  }

  listings() {
    const now = Date.now() / 1000;
    const out = [];
    for (const t of this.tokens.values()) {
      if (!t.lastPrice) continue;
      const v = this.view(t, now);
      if (v && v.mcap > 0) out.push(v);
    }
    out.sort((a, b) => b.vol24 - a.vol24 || b.mcap - a.mcap);
    return out.slice(0, this.cfg.listLimit);
  }

  get(address) {
    const t = this.tokens.get(lc(address));
    return t && t.lastPrice ? this.view(t) : null;
  }

  status() {
    const span = this.head && this.startBlock != null ? Number(this.head - this.startBlock) : 0;
    const done = this.cursor != null && this.startBlock != null ? Number(this.cursor - this.startBlock) : 0;
    return {
      synced: this.synced,
      head: this.head?.toString() ?? null,
      cursor: this.cursor?.toString() ?? null,
      syncPct: span ? Math.min(100, Math.round((done / span) * 100)) : 0,
      tracked: this.tokens.size,
      ethUsd: this.prices.eth,
    };
  }
}
