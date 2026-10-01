import { test } from "node:test";
import assert from "node:assert/strict";
import { fillFromTitle } from "../../server/ai/title-reader.ts";
import { createBatcher } from "../../server/lib/batcher.ts";

const reading = { cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: null };

test("the title fills only what the item details leave out", async () => {
    const listing = { title: "CHARIZARD 1999 POKEMON BASE SET 4/102 RARE HOLO", aspects: { Character: "Charizard" } };
    const { aspects, filled } = await fillFromTitle(listing, async () => reading);

    assert.equal(aspects.Set, "Base Set");
    assert.equal(aspects["Card Number"], "4/102");
    assert.equal(aspects.Character, "Charizard");
    assert.deepEqual(filled, ["Set", "Card Number"]);
});

test("the seller's item details always win over the title", async () => {
    const listing = {
        title: "Charizard Base Set 4/102",
        aspects: { Set: "Celebrations: Classic Collection", "Card Number": "4/102", "Card Name": "Charizard" },
    };
    let asked = false;
    const { aspects, filled } = await fillFromTitle(listing, async () => {
        asked = true;
        return reading;
    });

    assert.equal(asked, false);
    assert.equal(aspects.Set, "Celebrations: Classic Collection");
    assert.deepEqual(filled, []);
});

test("single requests are answered in batches, each with its own answer", async () => {
    const batches = [];
    const double = createBatcher(
        async (numbers) => {
            batches.push(numbers.length);
            return numbers.map((n) => n * 2);
        },
        { maxSize: 3, maxWaitMs: 5 }
    );

    const answers = await Promise.all([1, 2, 3, 4, 5].map(double));

    assert.deepEqual(answers, [2, 4, 6, 8, 10]);
    assert.deepEqual(batches, [3, 2]);
});

test("a Set item detail that only names a printing gets filled from the title", async () => {
    const listing = {
        title: "1999 Pokemon Base Set Unlimited Charizard 4/102 MP",
        aspects: { Set: "Unlimited", "Card Number": "4/102", "Card Name": "Charizard" },
    };
    const { aspects, filled } = await fillFromTitle(listing, async () => reading);

    assert.equal(aspects.Set, "Base Set");
    assert.deepEqual(filled, ["Set"]);
});
