import test from "node:test";
import assert from "node:assert/strict";
import "../fixtures/isolated-data.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { collectorArtworkDecision, verifyCollectorArtwork } from "../../server/analysis/collector-artwork.ts";

test("a catalog lookup fills in the denominator before purchasing an artwork comparison", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
        assert.equal(url, "https://api.tcgdex.net/v2/en/sets/evolving%20skies/167");
        return Response.json({ id: "swsh7-167", localId: "167", name: "Leafeon V", image: "https://assets.tcgdex.net/en/swsh/swsh7/167",
            set: { id: "swsh7", name: "Evolving Skies", cardCount: { official: 203 } } });
    });
    const e = cardEvaluation();
    e.listing.photos = ["https://i.ebayimg.com/images/g/test/s-l1600.jpg"];
    e.photoCheck!.printedNumber = "167/204";
    const result = await verifyCollectorArtwork(e, { name: "Leafeon V", set: "Evolving Skies", cardNumber: "167" });
    assert.equal(result.matches, false);
    assert.match(result.reason, /conflicts with the catalog collector number 167\/203/);
    assert.equal(fetch.mock.callCount(), 1);
});

test("different art excludes the target without assigning a possibly misread sibling number", () => {
    const target = { cardName: "Leafeon V", cardNumber: "167/203" };
    const review = { listingNumber: "162/203", observation: "The listing shows orange rays. The reference shows autumn leaves." };
    const mismatch = collectorArtworkDecision(target, { ...review, artwork: "DIFFERENT_ART" });
    assert.equal(mismatch.matches, false);
    assert.match(mismatch.reason, /different artwork/);
    assert.doesNotMatch(mismatch.reason, /162/);
    assert.equal(collectorArtworkDecision(target, { ...review, artwork: "SAME_ART" }).matches, false);
    assert.equal(collectorArtworkDecision(target, { ...review, artwork: "UNCLEAR", listingNumber: "167/203" }).matches, false);
    assert.equal(collectorArtworkDecision(target, { ...review, artwork: "SAME_ART", listingNumber: "167/203" }).matches, true);
});
