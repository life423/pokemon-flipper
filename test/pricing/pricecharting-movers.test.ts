import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { importMovers, moverCardSeeds, moversSchedule, moversUrl, parseMovers, recentMoverSeeds } from "../../server/pricing/pricecharting-movers.ts";

const product = (id: number, name: string, set: string, change: string) =>
    `<tr data-product="${id}"><td><a href="https://www.pricecharting.com/game/pokemon-team-rocket/product-${id}">${name}</a></td><td>${set}</td><td>$1,023.45</td><td>${change}</td></tr>`;
const page = `<span id="dropdown_selected_currency">USD</span><select name="category"><option selected value="pokemon-cards">Pokémon</option></select>
<table id="games_table"><tr><th>Title</th><th>Console</th><th>Loose Price</th><th>Change</th></tr>
${product(123, "Dark Charizard #4", "Pokemon Team Rocket", "+$12.30")}
${product(124, "Booster Box", "Pokemon Team Rocket", "+$20.00")}
${product(125, "Dark Charizard [1st Edition] #4", "Pokemon Team Rocket", "+$15.00")}
${product(126, "Gengar #20", "Pokemon Fossil", "−$4.00")}
${product(127, "Charizard #6", "Pokemon Japanese Base Set", "+$8.25")}</table>`;

test("movers preserve signed USD guide changes and sealed products, exposing only compatible rising card leads", () => {
    const rows = parseMovers(page);
    assert.equal(rows.length, 5);
    assert.equal(rows[0].loosePriceUsd, 1023.45);
    assert.equal(rows[3].changeUsd, -4);
    assert.deepEqual(moverCardSeeds({ source: moversUrl, observedAt: "2026-11-26", rows }), [{ name: "Dark Charizard", set: "Team Rocket", number: "4", mover: "PriceCharting Big Movers" }]);
    for (const changed of [page.replace("USD", "CAD"), page.replace("Loose Price", "Graded Price"),
        page.replace("selected value", "value"), page.replace("$1,023.45", "n/a")]) assert.throws(() => parseMovers(changed));
});

test("one claim per Central day survives overlap and failure and preserves the preceding snapshot", async () => {
    const now = Date.parse("2026-02-18T14:00:00Z"), tomorrow = now + 86400000;
    let calls = 0;
    const fetchPage = async () => { calls++; return new Response(page); };
    await Promise.all(Array.from({ length: 6 }, () => importMovers({ now, fetchPage })));
    assert.equal(calls, 1);
    assert.equal((await importMovers({ now, fetchPage }))?.rows.length, 5);
    await assert.rejects(importMovers({ now: tomorrow, fetchPage: async () => { calls++; return new Response("outage", { status: 503 }); } }), /503/);
    assert.equal(await importMovers({ now: tomorrow, fetchPage }), null);
    assert.equal(calls, 2);
    const original = process.env.PRICECHARTING_BUYER_USE_AUTHORIZED;
    try {
        delete process.env.PRICECHARTING_BUYER_USE_AUTHORIZED;
        assert.deepEqual(await recentMoverSeeds(tomorrow), []);
        process.env.PRICECHARTING_BUYER_USE_AUTHORIZED = "true";
        assert.equal((await recentMoverSeeds(tomorrow))[0]?.name, "Dark Charizard");
        assert.deepEqual(await recentMoverSeeds(tomorrow + 86400000), []);
    } finally {
        if (original === undefined) delete process.env.PRICECHARTING_BUYER_USE_AUTHORIZED;
        else process.env.PRICECHARTING_BUYER_USE_AUTHORIZED = original;
    }
});

test("daily schedule falls between 5 and 6 Central in summer and winter", () => {
    for (const [date, offset] of [["2026-07-01", "-05:00"], ["2026-12-01", "-06:00"]]) {
        assert.deepEqual(moversSchedule(Date.parse(date + "T04:59:00" + offset)), { day: date, due: false });
        assert.deepEqual(moversSchedule(Date.parse(date + "T05:59:00" + offset)), { day: date, due: true });
    }
});
