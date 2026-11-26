import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importPriceChartingGuide, priceChartingComparison, readPriceChartingGuide } from "../../server/pricing/pricecharting.ts";

const product = { id: "123", url: "https://www.pricecharting.com/game/pokemon-set/test-card-1" };
const at = "2026-11-25T12:00:00.000Z";
const html = `<link rel="canonical" href="${product.url}"><h1 id="product_name" title="123">Test</h1>
<a id="dropdown_selected_currency">USD</a>
<table id="price_data"><thead><tr><th>Ungraded</th><th>Grade 9</th><th>PSA 10</th></tr></thead>
<tbody><tr><td id="used_price"><span class="price js-price">$24.00</span><span class="change">$1.50</span></td>
<td id="graded_price"><span class="price">-</span></td><td id="manual_only_price"><span class="price">$1,200.25</span></td>
</tr></tbody></table>
<select id="completed-auctions-condition"><option value="completed-auctions-used">Ungraded (1)</option>
<option value="completed-auctions-cib">Grade 7 (1)</option><option value="completed-auctions-new">Grade 8 (0)</option>
<option value="completed-auctions-graded">Grade 9 (0)</option></select>
<div class="completed-auctions-used"><table><tr id="ebay-123456789101"><td class="date">2026-11-20</td>
<td class="title"><a href="https://www.ebay.com/itm/123456789101">Test Card TAG 6</a></td><td class="numeric">
<span class="js-price" title="best offer accepted price">$18.00</span><span class="js-price listed-price-inline">$30.00</span></td></tr></table></div>
<div class="completed-auctions-cib"><table><tr id="other-abc+123"><td class="date">2026-11-21</td>
<td class="title">Test Card PSA 7</td><td class="numeric"><span class="js-price">$37.00</span></td></tr></table></div>`;

test("guide imports only current prices for the pinned product, currency and grade labels", () => {
    const quote = readPriceChartingGuide(html, product, at);
    assert.deepEqual(quote.prices, { Ungraded: 24, "PSA 10": 1200.25 });
    assert.equal(quote.history.unreadableRows, 0);
    assert.deepEqual(quote.history.sales.map(s => [s.source, s.price, s.guideBuckets[0], s.bucketConflict]), [
        ["ebay", 18, "Ungraded", true], ["other", 37, "Grade 7", undefined],
    ]);
    for (const wrong of [html.replace('title="123"', 'title="998"'), html.replace("USD", "CAD"),
        html.replace(product.url, product.url + "-first-edition"), html.replace("Grade 9", "CGC 9")]) {
        assert.throws(() => readPriceChartingGuide(wrong, product, at));
    }
});

test("concurrent and repeated imports share a daily observation and a later failure preserves history", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pc-guide-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let time = Date.parse(at), calls = 0;
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const opts = { directory, now: () => time, fetchPage: async () => {
        calls++; started.resolve(); await finish.promise; return new Response(html);
    } };
    const first = importPriceChartingGuide(product, opts);
    await started.promise;
    await assert.rejects(importPriceChartingGuide(product, opts), /in progress/);
    finish.resolve();
    const saved = await first;
    assert.deepEqual(await importPriceChartingGuide(product, opts), saved);
    assert.equal(calls, 1);
    time += 86_400_000;
    await assert.rejects(importPriceChartingGuide(product, { ...opts, fetchPage: async () => new Response("missing") }), /identity/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "history-v2", "123", "2026-11-25.json"), "utf8")), saved);
    assert.deepEqual((await importPriceChartingGuide(product, opts)).prices, saved.prices);
});

test("configured database reuses a daily import and upserts sales under stable marketplace transaction keys", async () => {
    const completed = new Map(), saleRows = new Map();
    let time = Date.parse(at), requests = 0;
    const database = {
        claimTask: async ({key}) => completed.has(key) ? {state:"COMPLETED", result:completed.get(key), claimed:false} : {claimed:true},
        completeTask: async (key, _owner, observation) => { completed.set(key, observation); },
        releaseTask: async () => {},
        importCacheEntries: async rows => { for (const row of rows) saleRows.set(row.key, row); },
    };
    const options = { database, now: () => time, fetchPage: async () => { requests++; return new Response(html); } };
    const first = await importPriceChartingGuide(product, options);
    assert.deepEqual(await importPriceChartingGuide(product, options), first);
    time += 86_400_000;
    await importPriceChartingGuide(product, options);
    assert.equal(requests, 2); assert.equal(completed.size, 2); assert.equal(saleRows.size, 2);
});

test("on-demand lookup requires an authorized exact catalog match and separates the guide from sale evidence", async () => {
    const identity = { status: "IDENTIFIED", name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105",
        printing: "UNLIMITED", finish: "HOLO", language: "English" };
    const catalog = JSON.stringify([{ ...identity, ...product }]);
    let calls = 0;
    const load = async exact => {
        assert.deepEqual(exact, product);
        calls++;
        return readPriceChartingGuide(html, product, at);
    };
    const options = { authorized: true, catalog, load };
    assert.equal(await priceChartingComparison(identity, undefined, { ...options, authorized: false }), null);
    for (const changes of [{ language: "Japanese" }, { printing: "FIRST_EDITION" }, { finish: "REVERSE_HOLO" },
        { cardNumber: "6/102" }, { status: "NEEDS_REVIEW" }, { notThisCard: "Wrong artwork" }]) {
        assert.equal(await priceChartingComparison({ ...identity, ...changes }, undefined, options), null);
    }
    assert.equal(calls, 0);
    const quotes = await Promise.all([1, 2].map(() => priceChartingComparison(identity, undefined, options)));
    assert.equal(calls, 1);
    assert.deepEqual(quotes[0], quotes[1]);
    assert.deepEqual(quotes[0].prices.map(row => [row.source, row.price]), [["PriceCharting", 24], ["PriceCharting", 1200.25]]);
    assert.match(quotes[0].observation, /Ungraded guide · mixed conditions \$24.00.*2 distinct transactions, 1 with conflicting grade labels/);
    assert.match(quotes[0].observation, /Ungraded: 0 observed.*Grade 7: 1 observed, 1 selling day, 0.02\/day, median \$37.00/);
    const published = readPriceChartingGuide(html, product, at);
    const sale = published.history.sales[1];
    const history = { ...published.history, sales: ["2026-09-26", "2026-09-27", "2026-11-25", "2026-11-25", "2026-11-26"]
        .map((soldOn, i) => ({ ...sale, soldOn, transactionId: String(i), price: [1000, 21, 23, 999, 800][i] })) };
    const counted = await priceChartingComparison(identity, undefined, { ...options, load: async () => ({ ...published, history }) });
    assert.match(counted.observation, /Grade 7: 3 observed, 2 selling days, 0.05\/day, median \$23.00/);
});

test("an optional guide failure leaves the listing usable and respects cancellation", async () => {
    const identity = { status: "IDENTIFIED", name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105",
        printing: "UNLIMITED", finish: "HOLO", language: "English" } as const;
    let requests = 0;
    const load = async () => { requests++; throw new Error("Guide store is unavailable"); };
    for (const catalog of ["invalid JSON", "{}", JSON.stringify([{ ...identity, ...product, id: null }])]) {
        assert.equal(await priceChartingComparison(identity, undefined, { authorized: true, catalog, load }), null);
    }
    assert.equal(requests, 0);
    const options = { authorized: true, catalog: JSON.stringify([{ ...identity, ...product }]), load };
    assert.deepEqual((await priceChartingComparison(identity, undefined, options))?.prices, []);
    assert.equal(requests, 1);
    await assert.rejects(priceChartingComparison(identity, AbortSignal.abort(), options), { name: "AbortError" });
});

test("PriceCharting shows overlapping eBay IDs once and preserves the exact edition, grade and reporting window", async () => {
    const identity = { status: "IDENTIFIED", name: "Dark Gengar", set: "Neo Destiny", cardNumber: "006/105",
        printing: "UNLIMITED", finish: "HOLO", language: "English" };
    const catalog = JSON.stringify([{ ...identity, cardNumber: "6/105", ...product }]);
    const snapshot = readPriceChartingGuide(html, product, at);
    const title = "Dark Gengar 6/105 Neo Destiny Holo";
    const sale = (transactionId: string, description = title, soldOn = "2026-11-20") => ({
        source: "ebay", transactionId, soldOn, price: 34, title: description,
        url: "https://www.ebay.com/itm/" + transactionId, guideBuckets: ["Ungraded"] });
    const first = sale("123456789101"), slab = sale("123456789102", title + " PSA 7");
    const history = { ...snapshot.history, sales: [first, first, sale("123456789103"), sale("123456789104", title + " 1st Edition"),
        sale("123456789105", title, "2026-10-25"), { ...slab, guideBuckets: ["Grade 7"] },
        { ...sale("123456789106", title + " CGC 7"), guideBuckets: ["Grade 7"] }] };
    const evaluation = { identity, photoCheck: { cardCount: "ONE", holder: "SLEEVE", images: [{ usable: true, view: "FRONT" }] },
        rawPricing: { prices: [{ comps: { sales: [{ url: first.url, price: 35 }] } }] } };
    const options = { authorized: true, catalog, evaluation, load: async () => ({ ...snapshot, history }) };
    const result = await priceChartingComparison(identity, undefined, options);
    assert.match(result.ebayActivity, /2 distinct eBay sales \(ungraded, across conditions\)/);
    assert.match(result.ebayActivity, /1 of these already appear/);
    assert.match(result.ebayActivity, /disagree on the price of 1 shared transaction/);
    const graded = { ...evaluation, slab: { grader: "PSA", grade: 7 },
        photoCheck: { ...evaluation.photoCheck, holder: "GRADED_SLAB", slab: { present: true } } };
    const reviewed = await priceChartingComparison(identity, undefined, { ...options, evaluation: graded });
    assert.match(reviewed.ebayActivity, /1 distinct eBay sale \(PSA 7\)/);
    assert.match(reviewed.ebayActivity, /0 of these already appear/);
    assert.equal(await priceChartingComparison({ ...identity, cardNumber: "6" }, undefined, options), null);
});
test("invalid calendar dates cannot enter guide history", () => {
    const quote = readPriceChartingGuide(html.replace("2026-11-20", "2026-02-30"), product, at);
    assert.equal(quote.history.unreadableRows, 1);
    assert.equal(quote.history.sales.length, 1);
    const partial = readPriceChartingGuide(html.replace("Grade 7 (1)", "Grade 7 (500)"), product, at);
    assert.equal(partial.history.unpublishedRows, 499);
    assert.equal(partial.history.unreadableRows, 0);
});
