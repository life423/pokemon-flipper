import assert from "node:assert/strict";
import test from "node:test";
import { parseEuroReference } from "../../server/pricing/euro-reference.ts";
import { cardmarketScenario } from "../../client/src/search/cardmarket-scenario.ts";

test("Cardmarket quote requires a dated current USD rate; a missing FX rate still leaves the EUR ask usable", () => {
    const now = Date.parse("2026-11-24T17:00:00Z");
    const xml = "<Cube time='2026-11-23'><Cube currency='USD' rate='1.0939'/></Cube>";
    assert.deepEqual(parseEuroReference(xml, now), { date: "2026-11-23", usdPerEur: 1.0939 });
    assert.equal(parseEuroReference(xml.replace("2026-11-23", "2026-11-01"), now), null);
    assert.equal(parseEuroReference(xml.replace("2026-11-23", "2026-11-25"), now), null);
    assert.equal(parseEuroReference(xml.replace("USD", "AUD"), now), null);
});

test("a hypothetical ask comparison needs a delivered purchase and explicit selling costs, including real zeroes", () => {
    assert.deepEqual(cardmarketScenario(100, 1.10, 82.30, "5", "6"), { proceeds: 98.50, difference: 16.20 });
    assert.deepEqual(cardmarketScenario(100, 1.10, 120, "0", "0"), { proceeds: 110, difference: -10 });
    assert.equal(cardmarketScenario(100, 1.10, null, "5", "6"), null);
    assert.equal(cardmarketScenario(100, 1.10, 80, "5", ""), null);
    assert.equal(cardmarketScenario(100, 1.10, 80, "", "6"), null);
    assert.equal(cardmarketScenario(100, 1.10, 80, "101", "6"), null);
});
