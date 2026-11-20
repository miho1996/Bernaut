import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem";
import { PonsIndexer, defaultConfig, PONS } from "../server/indexer.js";
import { GET_TOKEN_INFO_SELECTOR, parseTokenInfo } from "../server/tokeninfo.js";
import { createApp } from "../server/index.js";

const TOKEN = "0x1000000000000000000000000000000000000001";
const WETH = "0x9000000000000000000000000000000000000009";
const POOL = "0x5000000000000000000000000000000000000005";
const DEV = "0xdd000000000000000000000000000000000000dd";
const SNIPER = "0xaa000000000000000000000000000000000000aa";
const BUYER = "0xbb000000000000000000000000000000000000bb";
const E18 = 10n ** 18n;
const LAUNCH = 1000n;
const NOW = Math.floor(Date.now() / 1000);

const infoHex = encodeAbiParameters(parseAbiParameters("(address,string,string,string,string,string,string,string)"), [
  [DEV, "ipfs://QmLogo123", "The best frog on Robinhood", "https://x.com/frog", "https://t.me/frog", "", "https://frog.fun", ""],
]);
// цена 1e-6 WETH за токен, токен = token0 → sqrtPriceX96 = sqrt(1e-6) * 2^96
const SQRT = BigInt(Math.round(1e-3 * 2 ** 96));

function fakeClient() {
  const launch = {
    eventName: "TokenLaunched", address: PONS.factories[0], blockNumber: LAUNCH, logIndex: 0,
    args: { token: TOKEN, deployer: DEV, dexFactory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", pairToken: WETH, pool: POOL, initialBuyAmount: 0n },
  };
  const tr = (b, i, from, to, v) => ({ eventName: "Transfer", address: TOKEN, blockNumber: b, logIndex: i, args: { from, to, value: v } });
  const sw = (b, i, a0, a1) => ({ eventName: "Swap", address: POOL, blockNumber: b, logIndex: i, args: { amount0: a0, amount1: a1, sqrtPriceX96: SQRT } });
  const logs = [
    tr(LAUNCH, 1, "0x0000000000000000000000000000000000000000", POOL, 1_000_000_000n * E18),
    tr(LAUNCH, 2, POOL, DEV, 50_000_000n * E18), sw(LAUNCH, 3, -50_000_000n * E18, 50n * E18),
    tr(LAUNCH + 2n, 1, POOL, SNIPER, 10_000_000n * E18), sw(LAUNCH + 2n, 2, -10_000_000n * E18, 10n * E18),
    tr(LAUNCH + 100n, 1, POOL, BUYER, 1_000_000n * E18), sw(LAUNCH + 100n, 2, -1_000_000n * E18, 1n * E18),
    tr(LAUNCH + 150n, 1, BUYER, POOL, 500_000n * E18), sw(LAUNCH + 150n, 2, 500_000n * E18, -(E18 / 2n)),
  ];
  const head = LAUNCH + 200n;
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(NOW - Number(head - blockNumber)) }),
    getLogs: async ({ event, fromBlock, toBlock, address }) => {
      const want = event.name;
      const addrs = [].concat(address).map((a) => a.toLowerCase());
      const all = want === "TokenLaunched" ? [launch] : logs.filter((l) => l.eventName === want);
      return all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && addrs.includes(l.address.toLowerCase()));
    },
    readContract: async ({ address, functionName }) => {
      const a = address.toLowerCase();
      if (functionName === "graduationStatus") return [50n, 100n, false];
      if (functionName === "symbol") return a === WETH ? "WETH" : "FROG";
      if (functionName === "name") return "Frog <img src=x onerror=alert(1)>";
      if (functionName === "decimals") return 18;
      if (functionName === "totalSupply") return 1_000_000_000n * E18;
      if (functionName === "balanceOf") return 60n * E18; // WETH в пуле
      throw new Error("unexpected " + functionName);
    },
    call: async ({ data }) => { assert.equal(data, GET_TOKEN_INFO_SELECTOR); return { data: infoHex }; },
  };
}

const quiet = { info() {}, warn() {}, error() {} };
const fetchEth = async () => ({ ok: true, json: async () => ({ ethereum: { usd: 3000 }, bitcoin: { usd: 90000 } }) });

async function syncedIndexer() {
  const ix = new PonsIndexer({ ...defaultConfig({}), backfillHours: 1 }, { client: fakeClient(), fetchImpl: fetchEth, log: quiet });
  await ix.updatePrices();
  ix.head = await ix.client.getBlockNumber();
  ix.startBlock = LAUNCH - 1n;
  await ix.scanRange(LAUNCH - 1n, ix.head);
  ix.cursor = ix.head;
  await ix.refreshAll();
  return ix;
}

test("selector getTokenInfo()", () => {
  assert.equal(GET_TOKEN_INFO_SELECTOR, toFunctionSelector("getTokenInfo()"));
});

test("parseTokenInfo вытаскивает лого, описание и соцсети", () => {
  const i = parseTokenInfo(infoHex);
  assert.equal(i.logo, "https://ipfs.io/ipfs/QmLogo123");
  assert.equal(i.description, "The best frog on Robinhood");
  assert.equal(i.socials.x, "https://x.com/frog");
  assert.equal(i.socials.tg, "https://t.me/frog");
  assert.equal(i.socials.web, "https://frog.fun");
});

test("индексатор считает метрики токена", async () => {
  const ix = await syncedIndexer();
  const [t] = ix.listings();
  assert.ok(t, "токен есть в листинге");
  assert.equal(t.ticker, "FROG");
  assert.ok(Math.abs(t.price - 0.003) < 1e-6, "цена 1e-6 WETH × $3000");
  assert.ok(Math.abs(t.mcap - 3_000_000) < 10);
  assert.equal(t.progress, 50);
  assert.equal(t.graduated, false);
  assert.equal(t.dev, 5);
  assert.equal(t.snipers, 1); // SNIPER купил на 2-м блоке, BUYER на 100-м — не снайпер
  assert.equal(t.holders, 3);
  assert.ok(Math.abs(t.top10 - 6.05) <= 0.051);
  assert.equal(t.buys, 3);
  assert.equal(t.sells, 1);
  assert.ok(Math.abs(t.vol24 - 61.5 * 3000) < 1);
  assert.equal(t.devPrev, 0);
  assert.equal(t.pts.length, 40);
  assert.equal(t.logo, "https://ipfs.io/ipfs/QmLogo123");
  assert.ok(t.socials.x && t.socials.tg && t.socials.web);
  // ликвидность = WETH в пуле + токены в пуле по текущей цене
  assert.ok(Math.abs(t.liq - (60 * 3000 + 939_500_000 * 0.003)) < 10);
});

test("HTTP: листинги, статус, AI-обзор и кэш", async () => {
  const ix = await syncedIndexer();
  let calls = 0;
  const fakeAnthropic = async (url, opts) => {
    calls++;
    assert.match(url, /api\.anthropic\.com\/v1\/messages/);
    const body = JSON.parse(opts.body);
    assert.match(body.messages[0].content, /"ticker": "FROG"/);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: 'вот:\n{"verdict":"wait","confidence":61,"summary":"ok","pros":[],"risks":[],"entry":"-","stop":"-","target":"-","size":"1%"}' }] }) };
  };
  const app = createApp({ indexer: ix, env: { ANTHROPIC_API_KEY: "k", REVIEW_RATE_PER_MIN: "1" }, fetchImpl: fakeAnthropic });
  const srv = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const l = await (await fetch(base + "/api/listings")).json();
    assert.equal(l.tokens.length, 1);
    const st = await (await fetch(base + "/api/status")).json();
    assert.equal(st.ai, true);
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /BERNAUT/);
    const r1 = await fetch(base + `/api/review/${TOKEN}`, { method: "POST" });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).verdict, "wait");
    const r2 = await (await fetch(base + `/api/review/${TOKEN}`, { method: "POST" })).json();
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
    const r3 = await fetch(base + `/api/review/0x${"1".repeat(40)}`, { method: "POST" });
    assert.equal(r3.status, 404);
  } finally {
    srv.close();
  }
});
