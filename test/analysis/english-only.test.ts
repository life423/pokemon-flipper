import "../fixtures/mock-ai-spending.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { EnglishOnlyError, evaluationFailure } from "../../server/analysis/failure.ts";

test("English scope distinguishes unknown language and conflicting or non-English language evidence", () => {
    assert.equal(cardLanguageStatus("Charizard 4/102"), "UNKNOWN");
    for (const language of [null, "Unknown", "not visible", "N/A"]) assert.equal(cardLanguageStatus("Charizard", [language]), "UNKNOWN");
    for (const language of ["English", "EN", "ENG", "en-US"]) assert.equal(cardLanguageStatus("Charizard", [language]), "ENGLISH");
    for (const language of ["Japanese", "de", "French", "English / Japanese", "Chinese", "Multilingual"]) assert.equal(cardLanguageStatus("Charizard", [language]), "OTHER");
    assert.equal(cardLanguageStatus("Charizard Japanese PSA 9", ["English"]), "OTHER");
});

test("a direct non-English listing stops before title, photo or market AI requests", async t => {
    offlineEbayCredentials(t);
    let requests = 0;
    const id = `v1|foreign-${randomUUID()}|0`;
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        assert.equal(url.hostname, "api.ebay.com", "known foreign listings cannot dispatch AI or pricing");
        requests++;
        return Response.json({ itemId: id, title: "Charizard Base Set 4/102", itemWebUrl: "#", image: { imageUrl: "https://i.ebayimg.com/images/g/offline-foreign/s-l1600.jpg" },
            localizedAspects: [{ name: "Language", value: "German" }] });
    });
    const { evaluateBoundedListing: evaluateListing } = await import("../../server/analysis/bounded-evaluate.ts");
    await assert.rejects(evaluateListing(id), EnglishOnlyError);
    assert.equal(requests, 1);
    assert.deepEqual(evaluationFailure(new EnglishOnlyError()), { status: 422, code: "OTHER_LANGUAGE", error: new EnglishOnlyError().message, retryable: false });
});
