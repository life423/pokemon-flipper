import assert from "node:assert/strict";
import test from "node:test";
import { resolveCollectorReference } from "../../server/analysis/collector-reference.ts";
import { withSavedProviderEvidence } from "../../server/lib/saved-provider-evidence.ts";

const target = { name: "Leafeon V (Alternate Full Art)", set: "SWSH07: Evolving Skies", cardNumber: "167/203" };
function catalog(localId: string) {
    return { id: "swsh7-" + localId, localId, name: "Leafeon V", image: "https://assets.tcgdex.net/en/swsh/swsh7/" + localId,
        set: { id: "swsh7", name: "Evolving Skies", cardCount: { official: 203, total: 237 } } };
}

test("exact art uses the English catalog, printed set size and card number independent of the seller", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
        assert.equal(url, "https://api.tcgdex.net/v2/en/sets/evolving%20skies/167");
        return Response.json(catalog("167"));
    });
    const reference = await resolveCollectorReference(target);
    assert.deepEqual(reference, { cardName: "Leafeon V", setName: "Evolving Skies", cardNumber: "167/203",
        imageUrl: "https://assets.tcgdex.net/en/swsh/swsh7/167/high.jpg" });
    await withSavedProviderEvidence(provider => assert.fail("Cached reference required " + provider), async () => {
        assert.deepEqual(await resolveCollectorReference({ ...target, cardNumber: "0167/203" }), reference);
        assert.equal(await resolveCollectorReference({ ...target, name: "Espeon V" }), null);
        assert.equal(await resolveCollectorReference({ ...target, cardNumber: "167/237" }), null);
    });
    assert.equal(fetch.mock.callCount(), 1);
});

test("wrong artwork coordinates, language, host and transport failures never poison the next lookup", async t => {
    const regular = { ...target, cardNumber: "166/203" };
    const entry = catalog("166");
    const responses = [Response.json({ temporary: true }, { status: 429 }),
        Response.json({ ...entry, image: entry.image.replace("/166", "/167") }),
        Response.json({ ...entry, image: entry.image.replace("/en/", "/ja/") }),
        Response.json({ ...entry, image: entry.image.replace("assets.tcgdex.net", "example.org") }),
        Response.json(catalog("167")), Response.json(entry)];
    const fetch = t.mock.method(globalThis, "fetch", async () => responses.shift()!);
    for (let i = 0; i < 5; ++i) assert.equal(await resolveCollectorReference(regular), null);
    assert.equal((await resolveCollectorReference(regular))?.imageUrl, entry.image + "/high.jpg");
    assert.equal(fetch.mock.callCount(), 6);
});

test("saved-only misses and canceled catalog consumers leave the lookup available for a subsequent run", async t => {
    const other = { ...target, cardNumber: "168/203" };
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => {
        if (++calls === 1) {
            release();
            await new Promise<void>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
        }
        return Response.json(catalog("168"));
    });
    const missing: string[] = [];
    await assert.rejects(withSavedProviderEvidence(p => missing.push(p), () => resolveCollectorReference(other)), /TCGDEX/);
    assert.deepEqual(missing, ["TCGDEX"]);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const cancelled = resolveCollectorReference(other, controller.signal);
    await started;
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal((await resolveCollectorReference(other))?.cardNumber, "168/203");
    assert.equal(calls, 2);
});
