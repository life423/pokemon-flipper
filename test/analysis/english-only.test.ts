import "../fixtures/mock-ai-spending.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
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
    const { evaluateListing } = await import("../../server/analysis/evaluate.ts");
    await assert.rejects(evaluateListing(id), EnglishOnlyError);
    assert.equal(requests, 1);
    assert.deepEqual(evaluationFailure(new EnglishOnlyError()), { status: 422, code: "OTHER_LANGUAGE", error: new EnglishOnlyError().message, retryable: false });
});

test("a photo-discovered foreign card saves and reuses its answer without starting later paid stages", async t => {
    offlineEbayCredentials(t);
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-language-check";
    t.after(() => { if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey; });
    const id = `v1|foreign-photo-${randomUUID()}|0`;
    const reading = { ...cardEvaluation().photoCheck!, cardCount: "ONE", cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", finish: "HOLO", language: "Japanese", confidence: "HIGH", evidence: ["Japanese text visible."] } };
    let photoCalls = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.hostname === "api.ebay.com") return Response.json({ itemId: id, title: "Venusaur Base Set 15/102 Holo", itemWebUrl: "#", buyingOptions: ["FIXED_PRICE"],
            image: { imageUrl: `https://i.ebayimg.com/images/g/${id}/s-l1600.jpg` },
            localizedAspects: Object.entries({ Set: "Base Set", "Card Name": "Venusaur", "Card Number": "15/102" }).map(([name, value]) => ({ name, value })) });
        assert.equal(url.hostname, "api.openai.com", "foreign photo evidence cannot start pricing");
        const request = JSON.parse(String(init?.body));
        assert.equal(request.text.format.name, "photo_check", "no identity escalation, condition or sold-comp analysis");
        photoCalls++;
        return Response.json({ id: "offline-foreign-photo", object: "response", status: "completed", output_text: JSON.stringify(reading),
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(reading), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const { evaluateListing } = await import("../../server/analysis/evaluate.ts");
    const { loadSaved } = await import("../../server/analysis/store.ts");
    await assert.rejects(evaluateListing(id), EnglishOnlyError);
    assert.equal((await loadSaved(id))?.photoCheck?.result.cardIdentity?.language, "Japanese");
    await assert.rejects(evaluateListing(id), EnglishOnlyError);
    assert.equal(photoCalls, 1, "the saved rejection must not buy the same photo assessment again");
});
