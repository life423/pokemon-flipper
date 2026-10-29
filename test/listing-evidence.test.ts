import { test } from "node:test";
import assert from "node:assert/strict";
import { listingEvidenceKey, photoEvidenceKey, searchPhotosFitDetails } from "../shared/listing-evidence.ts";

const photo = (id: string, size = 500) => `https://i.ebayimg.com/images/g/${id}/s-l${size}.jpg`;
test("thumbnail resizing does not invalidate evidence, but changed, reordered, removed photos or title do", () => {
    const listing = { title: "Venusaur", images: [photo("front"), photo("back")] };
    assert.equal(listingEvidenceKey(listing), listingEvidenceKey({ ...listing, images: [photo("front", 1600), photo("back", 1600)] }));
    for (const changed of [{ ...listing, images: [photo("other")] }, { ...listing, images: [...listing.images].reverse() }, { ...listing, images: [photo("front")] }, { ...listing, title: "Charizard" }]) {
        assert.notEqual(listingEvidenceKey(listing), listingEvidenceKey(changed));
    }
    assert.notEqual(photoEvidenceKey(["https://other.example/s-l500.jpg"]), photoEvidenceKey(["https://other.example/s-l1600.jpg"]));
});

test("legacy details permit a search subset only when the lead and every supplied photo agree", () => {
    const details = [photo("front", 1600), photo("back", 1600), photo("detail", 1600)];
    assert.equal(searchPhotosFitDetails([photo("front"), photo("back")], details), true);
    assert.equal(searchPhotosFitDetails([photo("new-front")], details), false);
    assert.equal(searchPhotosFitDetails([photo("back"), photo("front")], details), false);
    assert.equal(searchPhotosFitDetails([], details), false);
    assert.equal(searchPhotosFitDetails([], []), true);
});
