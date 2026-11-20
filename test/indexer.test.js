import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from "viem";
import { PonsIndexer, defaultConfig, PONS } from "../server/indexer.js";
import { GET_TOKEN_INFO_SELECTOR, parseTokenInfo } from "../server/tokeninfo.js";
import { createApp } from "../server/index.js";

const TOKEN = "0x1000000000000000000000000000000000000001";
const CURVE = "0xc000000000000000000000000000000000000001";
const TOKEN2 = "0x2000000000000000000000000000000000000002";
const CURVE2 = "0xc000000000000000000000000000000000000002";
const POOLID = "0x" + "ab".repeat(32);
const DEV = "0xdd000000000000000000000000000000000000dd";
const SNIPER = "0xaa000000000000000000000000000000000000aa";
const BUYER = "0xbb000000000000000000000000000000000000bb";
const ZERO = "0x0000000000000000000000000000000000000000";
const E18 = 10n ** 18n;
const E15 = 10n ** 15n;
const LAUNCH = 1000n;
const NOW = Math.floor(Date.now() / 1000);
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");

// раскладка как у настоящего Pons V2: (deployer, logo, description, (twitter, telegram, discord, website, farcaster))
const infoHex = encodeAbiParameters(parseAbiParameters("address, string, string, (string, string, string, string, string)"), [
  DEV, "ipfs://QmLogo123", "The best frog on Robinhood", ["https://x.com/frog", "https://t.me/frog", "", "https://frog.fun", ""],
]);
// V4: currency0 = ETH, currency1 = токен; цена 1e-8 ETH за токен → raw token/ETH = 1e8 → sqrt = 1e4 * 2^96
const SQRT = BigInt(1e4) * 2n ** 96n;

function fakeClient() {
  const ev = (eventName, address, b, i, args, extra = {}) => ({ eventName, address, blockNumber: b, logIndex: i, args, ...extra });
  const launch = (token, curve, b) => ev("TokenLaunched", PONS.factory, b, 0, { token, curve, deployer: DEV, pairToken: ZERO, launchConfigId: 0n, graduationThreshold: 42n * 10n ** 17n });
  const tr = (tok, b, i, from, to, v) => ev("Transfer", tok, b, i, { from, to, value: v });
  const buy = (curve, b, i, who, q, tok) => ev("CurveBuy", curve, b, i, { buyer: who, recipient: who, quoteIn: q, tokensOut: tok, fee: q / 100n, tax: 0n });
  const sell = (curve, b, i, who, tok, q) => ev("CurveSell", curve, b, i, { seller: who, recipient: who, tokensIn: tok, quoteOut: q, fee: 0n, tax: 0n });
  const logs = [
    launch(TOKEN, CURVE, LAUNCH),
    tr(TOKEN, LAUNCH, 1, ZERO, CURVE, 1_000_000_000n * E18),
    tr(TOKEN, LAUNCH, 2, CURVE, DEV, 50_000_000n * E18), buy(CURVE, LAUNCH, 3, DEV, 100n * E15, 50_000_000n * E18),
    tr(TOKEN, LAUNCH + 2n, 1, CURVE, SNIPER, 10_000_000n * E18), buy(CURVE, LAUNCH + 2n, 2, SNIPER, 20n * E15, 10_000_000n * E18),
    tr(TOKEN, LAUNCH + 100n, 1, CURVE, BUYER, 1_000_000n * E18), buy(CURVE, LAUNCH + 100n, 2, BUYER, 2n * E15, 1_000_000n * E18),
    tr(TOKEN, LAUNCH + 150n, 1, BUYER, CURVE, 500_000n * E18), sell(CURVE, LAUNCH + 150n, 2, BUYER, 500_000n * E18, 1n * E15),
    // второй токен: graduation и сделка в Uniswap V4
    launch(TOKEN2, CURVE2, LAUNCH + 10n),
    ev("PoolGraduated", PONS.factory, LAUNCH + 160n, 5, { token: TOKEN2, positionId: 1n, tokenAmount: 200_000_000n * E18, pairTokenAmount: 42n * 10n ** 17n }, { transactionHash: "0xgrad" }),
    ev("Swap", PONS.poolManager, LAUNCH + 170n, 1, { id: POOLID, sender: BUYER, amount0: -1n * E18, amount1: 100_000_000n * E18, sqrtPriceX96: SQRT, liquidity: 1n, tick: 0, fee: 0 }),
  ];
  const head = LAUNCH + 200n;
  return {
    getBlockNumber: async () => head,
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(NOW - Number(head - blockNumber)) }),
    getLogs: async ({ event, events, fromBlock, toBlock, address, args }) => {
      const names = (events ?? [event]).map((e) => e.name);
      const addrs = [].concat(address).map((a) => a.toLowerCase());
      return logs.filter((l) => names.includes(l.eventName) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock && addrs.includes(l.address.toLowerCase()) && (!args?.id || args.id.includes(l.args.id)));
    },
    getTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, "0xgrad");
      return { logs: [{ address: PONS.poolManager, topics: ["0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", POOLID, pad(ZERO), pad(TOKEN2)] }] };
    },
    readContract: async ({ address, functionName }) => {
      const a = address.toLowerCase();
      if (functionName === "pairTokenEconomics") return [0n, 0n, 0]; // как в реальной сети для ETH
      if (functionName === "getLaunchConfig") return { supply: 10n ** 27n, curveFeeBps: 100n, phantomQuote: 168n * 10n ** 16n, graduationThreshold: 42n * 10n ** 17n };
      if (functionName === "getReserves") return a === CURVE ? [378n * 10n ** 16n, 939_500_000n * E18] : [168n * 10n ** 16n, 0n];
      if (functionName === "getLaunchedToken") return { phase: 2 };
      if (functionName === "symbol") return a === TOKEN ? "FROG" : "TOAD";
      if (functionName === "name") return "Frog <img src=x onerror=alert(1)>";
      if (functionName === "decimals") return 18;
      if (functionName === "totalSupply") return 1_000_000_000n * E18;
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

test("индексатор считает метрики токена на кривой", async () => {
  const ix = await syncedIndexer();
  const t = ix.get(TOKEN);
  assert.ok(t, "токен есть");
  assert.equal(t.ticker, "FROG");
  const px = (3.78 / 939_500_000) * 3000;
  assert.ok(Math.abs(t.price / px - 1) < 1e-9, "цена = quote/token × $ETH");
  assert.ok(Math.abs(t.mcap - px * 1e9) < 1);
  assert.equal(t.progress, 50, "(3.78 − 1.68) / 4.2");
  assert.equal(t.graduated, false);
  assert.equal(t.dev, 5);
  assert.equal(t.snipers, 1); // SNIPER купил на 2-м блоке, BUYER на 100-м — не снайпер
  assert.equal(t.holders, 3); // кривая не считается холдером
  assert.ok(Math.abs(t.top10 - 6.05) <= 0.051);
  assert.equal(t.buys, 3);
  assert.equal(t.sells, 1);
  assert.ok(Math.abs(t.vol24 - 0.123 * 3000) < 1e-6);
  assert.ok(Math.abs(t.liq - 2.1 * 2 * 3000) < 1e-6);
  assert.equal(t.devPrev, 0);
  assert.equal(t.pts.length, 40);
  assert.equal(t.logo, "https://ipfs.io/ipfs/QmLogo123");
  assert.ok(t.socials.x && t.socials.tg && t.socials.web);
});

test("graduation и сделки в Uniswap V4", async () => {
  const ix = await syncedIndexer();
  const t = ix.get(TOKEN2);
  assert.equal(t.graduated, true);
  assert.equal(t.progress, 100);
  assert.equal(t.lpBurned, true);
  assert.ok(Math.abs(t.price - 1e-8 * 3000) < 1e-12, "цена из sqrtPriceX96");
  assert.equal(t.buys, 1);
  assert.ok(Math.abs(t.liq - 5.2 * 2 * 3000) < 1e-6, "4.2 ETH при graduation + 1 ETH покупки");
  assert.equal(t.devPrev, 1, "у дева был прошлый запуск");
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
    assert.equal(l.tokens.length, 2);
    const st = await (await fetch(base + "/api/status")).json();
    assert.equal(st.ai, true);
    const html = await (await fetch(base + "/")).text();
    assert.match(html, /PRONOIA/);
    const r1 = await fetch(base + `/api/review/${TOKEN}`, { method: "POST" });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).verdict, "wait");
    const r2 = await (await fetch(base + `/api/review/${TOKEN}`, { method: "POST" })).json();
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
    const r3 = await fetch(base + `/api/review/0x${"1".repeat(40)}`, { method: "POST" });
    assert.equal(r3.status, 404);
    assert.equal((await fetch(base + "/img?u=" + encodeURIComponent("http://127.0.0.1/x.png"))).status, 400, "внутренние адреса запрещены");
    assert.equal((await fetch(base + "/img?u=file:///etc/passwd")).status, 400);
  } finally {
    srv.close();
  }
});
