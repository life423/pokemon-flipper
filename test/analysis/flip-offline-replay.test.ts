import assert from "node:assert/strict";
import test from "node:test";
import { replayFlipSelection } from "../../scripts/review/flip-selection-replay.ts";
import { marketKey, scoreRawForecasts } from "../../scripts/review/raw-resale-holdout.ts";

test("later sales use the newest prior independent forecast for the exact market and sale method", () => {
    const f = { identity: { recordId: 12, printing: "UNLIMITED", finish: "HOLO" }, variant: "holo", condition: "LIGHTLY_PLAYED",
        source: "finalist", issuedAt: "2026-04-01T18:00:00.000Z", listingId: "v1|111111111111|0", baseline: 20, expected: 25,
        trainingIds: ["https://www.ebay.com/itm/222222222222"], competitor: { delivered: 26 } };
    const market = marketKey(f);
    const sale = { id: "333333333333", price: 22, date: "2026-04-03", market, method: "fixed_price" };
    const future = { ...f, issuedAt: "2026-04-03T01:00:00.000Z", baseline: 100 };
    const results = scoreRawForecasts([future, f, { ...f, issuedAt: "2026-03-30T00:00:00.000Z", baseline: 1 }], [
        sale, { ...sale, id: "444444444444", method: "best_offer_accepted", price: 24 },
        { ...sale, id: "111111111111" }, { ...sale, id: "222222222222" }, { ...sale, date: "2026-01-19" },
        { ...sale, date: "2026-08-01" }, { ...sale, market: marketKey({ ...f, condition: "DAMAGED" }) },
        { ...sale, market: marketKey({ ...f, identity: { ...f.identity, printing: "FIRST_EDITION" } }) }]);
    assert.equal(results.rows.length, 2);
    const fixed = results.summary.find(r => r.source === "finalist" && r.method === "fixed_price");
    assert.equal(fixed.baseline.meanSignedUsd, -2);
    assert.equal(fixed.expected.meanSignedUsd, 3);
    assert.equal(results.summary.find(r => r.source === "finalist" && r.method === "best_offer_accepted").expected.meanSignedUsd, 1);
    const declined = scoreRawForecasts([{ ...f, expected: null }], [sale]).summary.find(r => r.source === "finalist" && r.method === "fixed_price");
    assert.equal(declined.baseline.n, 1);
    assert.equal(declined.expected.n, 0);
    assert.equal(declined.pairedBaseline.n, 0);
});

test("selection replay keeps old ID-only exclusions unknown and separates overflow from rejection and photo work", async () => {
    const query = "Test";
    const events = [
        ["started", { request: { filters: { typeFilter: "FIXED_PRICE" } } }],
        ["page", { query, page: { listings: [], rejections: [{ id: "old", reason: "OTHER_CARD" }] } }],
        ["screened", { query, dispositions: [{ id: "next", outcome: "NOT_REACHED", reason: "ENOUGH_CANDIDATES" },
            { id: "later", outcome: "REJECTED", reason: "OTHER_CARD" }] }],
        ["queue", { query, dispositions: [{ id: "later", reason: "ELIGIBLE_FOR_REVIEW" }] }],
        ["check", { id: "later", action: "inspect_photos" }],
    ].map(([event,evidence],i) => ({ event, evidence, version: 1, pass: "pass", searchId: "account", index: i + 1 }));
    const report = await replayFlipSelection({ events, damagedLines: 0 }, { evaluations: new Map(), fronts: new Map() });
    const row = id => report.rows.find(r => r.id === id);
    assert.equal(row("old").beforePhotos, true);
    assert.equal(row("old").hasSnapshot, false);
    assert.equal(row("old").physical, "unknown");
    assert.equal(row("next").deferredOnly, true);
    assert.equal(row("next").beforePhotos, false);
    assert.equal(row("later").beforePhotos, false);
    assert.equal(row("later").galleryStarted, true);
    assert.equal(report.complete, false);
});
