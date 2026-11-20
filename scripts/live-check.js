// Живая проверка индексатора на настоящем Robinhood Chain.
//   RPC_URL=https://rpc.mainnet.chain.robinhood.com BACKFILL_HOURS=0.5 npm run check:live
import { PonsIndexer, defaultConfig } from "../server/indexer.js";

const cfg = { ...defaultConfig(), rpcUrl: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com" };
const ix = new PonsIndexer(cfg);
await ix.start();
const deadline = Date.now() + 8 * 60 * 1000;
while (!ix.synced && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000));
await ix.refreshAll();
ix.stop();

const st = ix.status();
const list = ix.listings();
console.log("status", JSON.stringify(st));
console.log("listings", list.length);
for (const t of list.slice(0, 8)) {
  console.log(
    [t.ticker.padEnd(12), "mc $" + Math.round(t.mcap), "prog " + t.progress + "%", t.graduated ? "GRAD" : "", "hold " + t.holders, "top10 " + t.top10 + "%", "dev " + t.dev + "%", "snip " + t.snipers + "%", "b/s " + t.buys + "/" + t.sells, "vol $" + Math.round(t.vol24), "liq $" + Math.round(t.liq), "x:" + !!t.socials.x].join("  ")
  );
}
process.exit(st.synced && list.length > 0 ? 0 : 1);
