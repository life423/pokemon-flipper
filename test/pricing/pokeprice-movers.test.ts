import "../fixtures/isolated-data.ts";
import { closeMarketCache } from "../../server/pricing/market-cache.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePokePriceMovers, parsePokePriceDetail, importPokePrice, recentPokePriceSnapshot } from "../../server/pricing/pokeprice-movers.ts";

const now = Date.parse("2026-11-26T14:00Z");
const link = (sku: string) => `<li><a href="/cards/${sku}"><p>Pikachu</p><p>Neo Genesis</p><p>$15.76</p><span>+58.5%</span></a></li>`;
const page = `<p>The biggest Pokémon card price changes last 30 days, comparing TCGplayer market prices. Updated November 26, 2026.</p>
<section><h2>Biggest Gains</h2><ol>${link("neo1-70")}${link("neo1-70")}</ol></section>
<section><h2>Biggest Drops</h2><ol>${link("neo1-8")}</ol></section>`;
const detail = `<script type="application/ld+json">{"@type":"Product","sku":"neo1-70"}</script>
<h1>Pikachu<span>Neo Genesis · #70</span></h1><h2>Prices &amp; Marketplace</h2>
<div><div><h3>Buy on eBay</h3><span>active asks · 1d ago</span></div><a><span>eBay</span><span>CGC 9</span><span>Lowest $89.99</span><span>3 active listings</span></a></div>
<div><div><h2>Recent sales</h2></div><div><div><div><div>Raw / Ungraded</div><div>7 sold · range $3–$20</div></div><div><div>$9.95</div><div>median</div></div></div></div></div>
<div><div><h3>TCGPlayer (NM market)</h3></div><div><div><span>Unlimited</span><div><span>low $6.00</span><span>$15.76</span></div></div></div></div>
<div><h3>Price History</h3><div><div><span>2 price points</span><span>+58.6% (+$5.82)</span></div><svg></svg><div><span>Nov 14</span><span>$9.94 – $15.76</span><span>Nov 20</span></div></div></div>`;

test("daily public gains separate asks, sold grades, TCGplayer variants and observed moves", async t => {
    t.after(closeMarketCache);
    const leads = parsePokePriceMovers(page);
    assert.equal(leads.rows.length, 1);
    const card = parsePokePriceDetail(detail, leads.rows[0], now);
    assert.equal(card.ebayAsks[0].lowestUsd, 89.99);
    assert.equal(card.ebaySales[0].medianUsd, 9.95);
    assert.equal(card.tcgplayerNm[0].finish, "Unlimited");
    assert.equal(card.chartChange?.deltaUsd, 5.82);
    assert.throws(() => parsePokePriceDetail(detail.replace('"neo1-70"', '"neo1-7"'), leads.rows[0], now));
    assert.throws(() => parsePokePriceMovers(page.replace("Biggest Gains", "Market Index")));
    let calls = 0;
    const run = () => importPokePrice({ now, delayMs: 0, fetchPage: async url => { calls++; return new Response(String(url).endsWith("movers") ? page : detail); } });
    await Promise.all([run(), run()]);
    assert.equal((await run())?.rows[0].detail?.ebayAsks[0].grade, "CGC 9");
    assert.equal(calls, 2);
    assert.equal((await recentPokePriceSnapshot(now))?.rows[0].number, "70");
    assert.equal(await recentPokePriceSnapshot(now + 10 * 86_400_000), null);
});
