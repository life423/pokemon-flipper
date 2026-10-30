import { test } from "node:test";
import assert from "node:assert/strict";
import { getListingDetails, type ListingDetails } from "../../server/ebay/listings.ts";
import { evaluateListing } from "../../server/analysis/evaluate.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { photoEvidenceKey } from "../../shared/listing-evidence.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

const photo = (id: string, size = 500) => `https://i.ebayimg.com/images/g/${id}/s-l${size}.jpg`;
function details(id: string, images = [photo("front", 1600), photo("back", 1600)]): ListingDetails {
    return { id, title: "Venusaur Base Set 15/102", url: "https://www.ebay.com/itm/123456789012", images, price: 20, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null, condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [], aspects: { Set: "Base Set", "Card Name": "Venusaur", "Card Number": "15/102" } };
}
function item(value: ListingDetails) {
    return { itemId: value.id, title: value.title, itemWebUrl: "https://www.ebay.com/itm/123456789012", buyingOptions: ["FIXED_PRICE"], price: { value: "20", currency: "USD" },
        image: value.images[0] ? { imageUrl: value.images[0] } : undefined, additionalImages: value.images.slice(1).map((imageUrl) => ({ imageUrl })),
        localizedAspects: Object.entries(value.aspects).map(([name, value]) => ({ name, value })) };
}

test("unchanged legacy search photos reuse details, while changed, removed photos and title refresh once", async (t) => {
    offlineEbayCredentials(t);
    const id = `v1|freshness-${Date.now()}|0`;
    let current = details(id);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        assert.match(String(url), /api\.ebay\.com\/buy\/browse\/v1\/item\//);
        requests += 1;
        return Response.json(item(current));
    });
    await writeCache(`ebay:item:${id}`, current);
    await getListingDetails(id, { expectedPhotos: [photo("front"), photo("back")], expectedTitle: current.title });
    assert.equal(requests, 0, "legacy thumbnail resolutions do not trigger paid work");
    await getListingDetails(id, { expectedPhotos: [photo("front", 960), photo("back", 960)] });
    assert.equal(requests, 0);
    for (const next of [details(id, [photo("front", 1600)]), details(id, [photo("new-front", 1600), photo("back", 1600)]), { ...details(id, [photo("new-front", 1600), photo("back", 1600)]), title: "Venusaur corrected listing title" }]) {
        current = next;
        const expectedPhotos = current.images.map((url) => url.replace("1600", "500"));
        const before: number = requests;
        const fresh = await getListingDetails(id, { expectedPhotos, expectedTitle: current.title });
        assert.deepEqual(fresh.images, current.images);
        assert.equal(requests, before + 1);
        await getListingDetails(id, { expectedPhotos, expectedTitle: current.title });
        assert.equal(requests, before + 1, "the new evidence snapshot stays cached");
    }
});

test("a changed-photo search and explicit full reanalysis both reject cached photo details", async (t) => {
    offlineEbayCredentials(t);
    let requests = 0;
    let current: ListingDetails;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        assert.match(String(url), /api\.ebay\.com\/buy\/browse\/v1\/item\//, "no AI or price calls are permitted");
        requests += 1;
        return Response.json(item(current));
    });
    for (const fresh of [false, true]) {
        const id = `v1|evaluation-refresh-${fresh}-${Date.now()}|0`;
        const cached = details(id);
        cached.searchPhotoKey = photoEvidenceKey(cached.images);
        await writeCache(`ebay:item:${id}`, cached);
        current = details(id, []);
        const evaluation = await evaluateListing(id, { fresh, current: { price: 20, shipping: 0, bids: 0, endTime: null, title: cached.title, images: fresh ? cached.images : [] } });
        assert.deepEqual(evaluation.listing.photos, []);
        assert.equal(evaluation.photoCheck, null, "old photo assessments cannot be displayed");
        assert.equal(evaluation.gradingMode, "BLOCKED");
    }
    assert.equal(requests, 2);
});
