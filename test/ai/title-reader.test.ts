import { test } from "node:test";
import assert from "node:assert/strict";
import { createTitleReader, fillFromTitle } from "../../server/ai/title-reader.ts";
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

test("title readings still use full batches of 25 and reuse cached answers", async () => {
    const batches = [];
    const cache = new Map();
    const read = createTitleReader({
        load: async (key) => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        read: async (titles) => {
            batches.push(titles.length);
            return titles.map(() => reading);
        },
    });

    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => read(`Card ${index}`)));
    assert.deepEqual(batches, [25, 25]);
    assert.ok(answers.every((answer) => answer === reading));
    assert.equal(await read("Card 0"), reading);
    assert.deepEqual(batches, [25, 25]);
});

test("cancelled title batches waiting for an AI slot do not make paid requests", async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    const read = createTitleReader({
        load: async () => null,
        save: async () => {},
        read: async (titles) => {
            calls += 1;
            if (calls === 4) started.resolve();
            await release.promise;
            return titles.map(() => reading);
        },
    });
    const stopped = new AbortController();
    const active = Array.from({ length: 100 }, (_, index) => read(`Active ${index}`));
    const queued = Array.from({ length: 25 }, (_, index) => read(`Cancelled ${index}`, stopped.signal));

    await started.promise;
    stopped.abort();
    release.resolve();

    assert.ok((await Promise.all(active)).every((answer) => answer === reading));
    assert.deepEqual(await Promise.all(queued), Array(25).fill(null));
    assert.equal(calls, 4);
});

test("one cancelled search does not cancel a shared title needed by another search", async () => {
    let calls = 0;
    const read = createTitleReader({
        load: async () => null,
        save: async () => {},
        read: async (titles) => { calls += 1; return titles.map(() => reading); },
    });
    const stopped = new AbortController();
    const live = new AbortController();
    const first = read("Shared title", stopped.signal);
    const second = read("Shared title", live.signal);
    stopped.abort();

    assert.deepEqual(await Promise.all([first, second]), [reading, reading]);
    assert.equal(calls, 1);
    assert.equal(await read("Already stopped", stopped.signal), null);
    assert.equal(calls, 1);
});
