// Индексатор лаунчпада Pons V2 на Robinhood Chain (chain id 4663).
//
// Как устроен Pons V2 (проверено по блокчейну, ноябрь 2026):
//  - PonsV2LaunchFactory 0x7ed5…ec7e эмитит TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold).
//    pairToken = 0x0 → нативный ETH.
//  - До graduation токен торгуется на своём контракте-кривой: CurveBuy / CurveSell.
//    curve.getReserves() → (quoteReserve, tokenReserve); в quoteReserve сидит «фантомная» ликвидность
//    (pairTokenEconomics(pair).phantomQuote, для ETH = 1.68). Цена = quote / token (constant product).
//    Прогресс = (quote − phantom) / graduationThreshold, graduation при 4.2 ETH реальных.
//  - Graduation: фабрика эмитит PoolGraduated(token, positionId, tokenAmount, pairTokenAmount),
//    в той же транзакции Uniswap V4 PoolManager эмитит Initialize(id, currency0, currency1, …, hooks = Pons hook).
//    Дальше сделки — Swap(id, …) на PoolManager. Позиция ликвидности навсегда лежит в locker.
//  - Метаданные: token.getTokenInfo() → (deployer, logo, description, socials{twitter,telegram,discord,website,farcaster}).
//
// Всё хранится в памяти. После рестарта сервис заново догоняет последние BACKFILL_HOURS.

import { createPublicClient, http, parseAbi, parseAbiItem, defineChain, formatUnits } from "viem";
import { GET_TOKEN_INFO_SELECTOR, parseTokenInfo } from "./tokeninfo.js";

export const PONS = {
  chainId: 4663,
  factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", // PonsV2LaunchFactory
  launchDeployer: "0x3711cea4feade896c913c68f01eda97cb06d1a42",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap V4
  hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
  locker: "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
};
export const NATIVE = "0x0000000000000000000000000000000000000000";

export const EV_LAUNCH = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
);
export const EV_GRAD = parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)");
export const EV_BUY = parseAbiItem("event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)");
export const EV_SELL = parseAbiItem("event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)");
export const EV_V4_INIT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);
export const EV_V4_SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
);
export const EV_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const FACTORY_ABI = parseAbi([
  "function pairTokenEconomics(address) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)",
  "function getLaunchConfig(uint256) view returns ((uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled))",
  "function getLaunchedToken(address) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
]);
const CURVE_ABI = parseAbi(["function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)"]);
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);

const ZERO = NATIVE;
const DEAD = "0x000000000000000000000000000000000000dead";
const lc = (a) => a.toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400;

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const byOrder = (a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

export function defaultConfig(env = process.env) {
  return {
    rpcUrl: env.RPC_URL,
    backfillHours: +(env.BACKFILL_HOURS ?? 6),
    pollMs: +(env.POLL_MS ?? 3000),
    refreshMs: +(env.REFRESH_MS ?? 20000),
    logChunk: +(env.LOG_CHUNK ?? 5000),
    sniperBlocks: +(env.SNIPER_BLOCKS ?? 50), // блоки ~0.1с → 50 блоков ≈ 5 секунд
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
    this.excluded = new Set([ZERO, DEAD, PONS.factory, PONS.launchDeployer, PONS.poolManager, PONS.hook, PONS.locker]);
    this.tokens = new Map(); // token → state
    this.curves = new Map(); // curve → token
    this.v4pools = new Map(); // poolId → token
    this.pairs = new Map(); // pairToken → { symbol, decimals, kind, phantom }
    this.configs = new Map(); // launchConfigId → phantomQuote (raw)
    this.deployers = new Map(); // deployer → [{ token, block }]  (не вычищается)
    this.rugged = new Set();
    this.prices = { eth: cfg.ethUsdFallback, btc: null, ts: 0 };
    this.blockTs = new Map();
    this.cursor = null;
    this.head = null;
    this.synced = false;
    this.chunk = cfg.logChunk;
    this.stopped = false;
    this.lastError = null;
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
    let lastReport = 0;
    while (!this.stopped) {
      try {
        this.head = await this.client.getBlockNumber();
        if (this.cursor >= this.head) {
          if (!this.synced) this.log.info?.(`[pons] synced: ${this.tokens.size} tokens`);
          this.synced = true;
          await sleep(this.cfg.pollMs);
          continue;
        }
        const to = this.cursor + BigInt(this.chunk) < this.head ? this.cursor + BigInt(this.chunk) : this.head;
        await this.scanRange(this.cursor + 1n, to);
        this.cursor = to;
        this.lastError = null;
        if (this.chunk < this.cfg.logChunk) this.chunk = Math.min(this.cfg.logChunk, this.chunk * 2);
        if (!this.synced && Date.now() - lastReport > 30000) {
          lastReport = Date.now();
          this.log.info?.(`[pons] backfill ${this.status().syncPct}% · ${this.tokens.size} tokens`);
        }
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e);
        this.lastError = msg.slice(0, 200);
        if (/range|too many|limit|exceed|10000|timeout|size|large/i.test(msg) && this.chunk > 10) {
          this.chunk = Math.max(10, Math.floor(this.chunk / 2));
          this.log.warn?.(`[pons] getLogs failed, chunk → ${this.chunk}: ${msg.slice(0, 160)}`);
          await sleep(500);
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
    // 1) запуски и graduation на фабрике
    const fac = await this.client.getLogs({ address: PONS.factory, events: [EV_LAUNCH, EV_GRAD], fromBlock: from, toBlock: to });
    fac.sort(byOrder);
    await pool(fac.filter((l) => l.eventName === "TokenLaunched"), 6, (l) => this.addToken(l));
    for (const l of fac.filter((l) => l.eventName === "PoolGraduated")) await this.onGraduated(l);

    const [tsFrom, tsTo] = await Promise.all([this.ts(from), this.ts(to)]);
    const tsOf = (bn) => (to === from ? tsTo : tsFrom + ((tsTo - tsFrom) * Number(bn - from)) / Number(to - from));

    // 2) сделки на кривых, сделки в V4 и трансферы токенов
    const logs = [];
    for (const c of chunks([...this.curves.keys()], 400)) logs.push(...(await this.client.getLogs({ address: c, events: [EV_BUY, EV_SELL], fromBlock: from, toBlock: to })));
    const ids = [...this.v4pools.keys()];
    for (const c of chunks(ids, 50)) logs.push(...(await this.client.getLogs({ address: PONS.poolManager, event: EV_V4_SWAP, args: { id: c }, fromBlock: from, toBlock: to })));
    for (const c of chunks([...this.tokens.keys()], 400)) logs.push(...(await this.client.getLogs({ address: c, event: EV_TRANSFER, fromBlock: from, toBlock: to })));
    logs.sort(byOrder);

    for (const l of logs) {
      const ts = tsOf(l.blockNumber);
      if (l.eventName === "CurveBuy" || l.eventName === "CurveSell") this.onCurveTrade(l, ts);
      else if (l.eventName === "Swap") this.onV4Swap(l, ts);
      else if (l.eventName === "Transfer") this.onTransfer(l, ts);
    }
  }

  async pairInfo(addr) {
    const a = lc(addr);
    if (!this.pairs.has(a)) {
      let symbol = "ETH", decimals = 18;
      if (a !== NATIVE) {
        [symbol, decimals] = await Promise.all([
          this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
          this.client.readContract({ address: addr, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
        ]);
      }
      const econ = await this.client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: "pairTokenEconomics", args: [addr] }).catch(() => null);
      const s = String(symbol).toUpperCase();
      const kind = a === NATIVE ? "eth" : /USD/.test(s) ? "usd" : /ETH/.test(s) ? "eth" : /BTC/.test(s) ? "btc" : "unknown";
      const dec = Number(decimals);
      const phantom = econ ? Number(formatUnits(econ[0], dec)) : 0;
      this.pairs.set(a, { symbol: String(symbol), decimals: dec, kind, phantom });
    }
    return this.pairs.get(a);
  }

  async configPhantom(id) {
    if (id == null) return null;
    const k = String(id);
    if (!this.configs.has(k)) {
      const c = await this.client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: "getLaunchConfig", args: [BigInt(id)] }).catch(() => null);
      if (!c) return null;
      this.configs.set(k, c.phantomQuote ?? c[2]);
    }
    return this.configs.get(k);
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
    const [pair, cfgPhantom, name, symbol, decimals, supply, launchTs] = await Promise.all([
      this.pairInfo(a.pairToken),
      this.configPhantom(a.launchConfigId),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "name" }).catch(() => ""),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
      this.client.readContract({ address: a.token, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => 0n),
      this.ts(l.blockNumber),
    ]);
    const t = {
      address: token,
      deployer: lc(a.deployer),
      curve: lc(a.curve),
      pairToken: lc(a.pairToken),
      poolId: null, // Uniswap V4 pool id после graduation
      isToken0: false, // в V4 нативный ETH всегда currency0
      decimals: Number(decimals),
      pairDecimals: pair.decimals,
      // фантомная ликвидность: из pairTokenEconomics, а для ETH (там нули) — из launch config
      phantom: pair.phantom > 0 ? pair.phantom : cfgPhantom != null ? Number(formatUnits(cfgPhantom, pair.decimals)) : a.pairToken.toLowerCase() === NATIVE ? 1.68 : 0,
      threshold: Number(formatUnits(a.graduationThreshold ?? 0n, pair.decimals)) || 4.2,
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
      pairBal: 0, // реальная ликвидность в пар-токене
      info: null,
      lastActivity: launchTs,
      dirty: true,
      peakMcap: 0,
      devSold: false,
    };
    // стартовая цена кривой: phantom / supply
    if (t.phantom > 0) t.lastPrice = t.phantom / t.supply;
    this.tokens.set(token, t);
    this.curves.set(t.curve, token);
    this.excluded.add(t.curve);
    if (!this.deployers.has(t.deployer)) this.deployers.set(t.deployer, []);
    this.deployers.get(t.deployer).push({ token, block: l.blockNumber });
  }

  async onGraduated(l) {
    const t = this.tokens.get(lc(l.args.token));
    if (!t) return;
    t.graduated = true;
    t.progress = 100;
    t.pairBal = Number(formatUnits(l.args.pairTokenAmount, t.pairDecimals));
    t.dirty = true;
    try {
      const rc = await this.client.getTransactionReceipt({ hash: l.transactionHash });
      for (const x of rc.logs) {
        // Initialize(id, currency0, currency1, …) от PoolManager в той же транзакции
        if (lc(x.address) !== PONS.poolManager || !x.topics[0]?.startsWith("0xdd466e67")) continue;
        const c0 = "0x" + x.topics[2].slice(26), c1 = "0x" + x.topics[3].slice(26);
        if (c0 !== t.address && c1 !== t.address) continue;
        t.poolId = x.topics[1];
        t.isToken0 = c0 === t.address;
        this.v4pools.set(t.poolId, t.address);
        break;
      }
    } catch (e) {
      this.log.warn?.(`[pons] graduation receipt ${t.address}: ${e.message}`);
    }
  }

  trimSwaps(t, ts) {
    const cutoff = ts - DAY;
    let i = 0;
    while (i < t.swaps.length - 1 && t.swaps[i + 1].ts < cutoff) i++;
    if (i > 0) t.swaps.splice(0, i);
  }

  onCurveTrade(l, ts) {
    const t = this.tokens.get(this.curves.get(lc(l.address)));
    if (!t) return;
    const a = l.args;
    const q = (v) => Number(formatUnits(v, t.pairDecimals));
    const k = (v) => Number(formatUnits(v, t.decimals));
    let price, pairAmt, buy;
    if (l.eventName === "CurveBuy") {
      buy = true;
      pairAmt = q(a.quoteIn);
      const tok = k(a.tokensOut);
      price = tok > 0 ? (pairAmt - q(a.fee) - q(a.tax)) / tok : 0;
      const who = lc(a.recipient);
      if (!t.firstBuy.has(who)) t.firstBuy.set(who, l.blockNumber);
    } else {
      buy = false;
      pairAmt = q(a.quoteOut);
      const tok = k(a.tokensIn);
      price = tok > 0 ? (pairAmt + q(a.fee) + q(a.tax)) / tok : 0;
      if (lc(a.seller) === t.deployer) t.devSold = true;
    }
    if (price > 0) t.lastPrice = price;
    t.swaps.push({ ts, price: price || t.lastPrice, buy, pairAmt });
    t.lastActivity = ts;
    t.dirty = true;
    this.trimSwaps(t, ts);
  }

  priceFromSqrt(t, sqrtPriceX96) {
    const r = Number(sqrtPriceX96) / 2 ** 96;
    const p = r * r; // raw currency1 / raw currency0
    if (!p) return 0;
    const scale = 10 ** (t.decimals - t.pairDecimals);
    return t.isToken0 ? p * scale : (1 / p) * scale;
  }

  onV4Swap(l, ts) {
    const t = this.tokens.get(this.v4pools.get(l.args.id));
    if (!t) return;
    const { amount0, amount1, sqrtPriceX96, sender } = l.args;
    const amtTok = t.isToken0 ? amount0 : amount1;
    const amtPair = t.isToken0 ? amount1 : amount0;
    // В V4 дельты — со стороны свопера: >0 получил, <0 отдал
    const buy = amtTok > 0n;
    const pairAmt = Math.abs(Number(formatUnits(amtPair < 0n ? -amtPair : amtPair, t.pairDecimals)));
    t.pairBal = Math.max(0, t.pairBal + (buy ? pairAmt : -pairAmt));
    const price = this.priceFromSqrt(t, sqrtPriceX96);
    if (price > 0) t.lastPrice = price;
    t.swaps.push({ ts, price: price || t.lastPrice, buy, pairAmt });
    if (!buy && lc(sender) === t.deployer) t.devSold = true;
    t.lastActivity = ts;
    t.dirty = true;
    this.trimSwaps(t, ts);
  }

  onTransfer(l, ts) {
    const t = this.tokens.get(lc(l.address));
    if (!t) return;
    const from = lc(l.args.from), to = lc(l.args.to);
    const v = Number(formatUnits(l.args.value, t.decimals));
    if (from !== ZERO) t.balances.set(from, (t.balances.get(from) ?? 0) - v);
    t.balances.set(to, (t.balances.get(to) ?? 0) + v);
    if (from === PONS.poolManager && !this.excluded.has(to) && !t.firstBuy.has(to)) t.firstBuy.set(to, l.blockNumber);
    t.lastActivity = Math.max(t.lastActivity, ts);
  }

  // ---------- on-chain state ----------
  async refreshAll() {
    const todo = [...this.tokens.values()].filter((t) => t.dirty || !t.info);
    await pool(todo, 8, async (t) => {
      try {
        const [res, info] = await Promise.all([
          t.graduated ? null : this.client.readContract({ address: t.curve, abi: CURVE_ABI, functionName: "getReserves" }).catch(() => null),
          t.info ? null : this.client.call({ to: t.address, data: GET_TOKEN_INFO_SELECTOR }).then((r) => parseTokenInfo(r.data)).catch(() => null),
        ]);
        if (res && !t.graduated) {
          const q = Number(formatUnits(res[0], t.pairDecimals));
          const k = Number(formatUnits(res[1], t.decimals));
          if (k > 0) {
            t.lastPrice = q / k;
            t.pairBal = Math.max(0, q - t.phantom);
            t.progress = Math.max(0, Math.min(99, Math.round((t.pairBal / t.threshold) * 100)));
          } else {
            // токены ушли с кривой → graduation (событие могли пропустить)
            const lt = await this.client.readContract({ address: PONS.factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [t.address] }).catch(() => null);
            if (lt && Number(lt.phase) >= 2) { t.graduated = true; t.progress = 100; }
          }
        }
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
  drop(t) {
    this.tokens.delete(t.address);
    this.curves.delete(t.curve);
    if (t.poolId) this.v4pools.delete(t.poolId);
  }

  // ---------- projection to frontend shape ----------
  view(t, now = Date.now() / 1000) {
    const pairUsd = this.pairUsd(t.pairToken);
    if (pairUsd == null) return null;
    const price = t.lastPrice * pairUsd;
    const mcap = price * t.supply;

    const holders = [];
    for (const [a, b] of t.balances) {
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
    // ликвидность: реальные пар-токены × 2 (вторая сторона — токены по текущей цене)
    const liq = t.pairBal * 2 * pairUsd;

    // 40 точек цены за жизнь токена (максимум сутки)
    const span = Math.max(60, Math.min(DAY, now - t.launchTs));
    const start = now - span;
    const pts = [];
    const startPrice = t.phantom > 0 ? t.phantom / t.supply : t.lastPrice;
    let j = 0, last = t.swaps.filter((s) => s.ts < start).pop()?.price ?? (t.swaps.length ? startPrice : t.lastPrice);
    for (let k = 0; k < 40; k++) {
      const edge = start + (span * (k + 1)) / 40;
      while (j < t.swaps.length && t.swaps[j].ts <= edge) last = t.swaps[j++].price;
      pts.push((last || t.lastPrice || 1) * pairUsd);
    }
    pts[39] = price || pts[39];
    const hourAgo = t.swaps.filter((s) => s.ts <= now - 3600).pop()?.price ?? (t.launchTs > now - 3600 ? startPrice : t.swaps[0]?.price) ?? t.lastPrice;
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
      pool: t.poolId ?? t.curve,
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
      // Pons навсегда блокирует ликвидность выпускника в locker
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
      graduated: [...this.tokens.values()].filter((t) => t.graduated).length,
      ethUsd: this.prices.eth,
      lastError: this.lastError,
    };
  }
}
