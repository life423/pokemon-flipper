import "../fixtures/mock-ai-spending.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

// Exercise the real evaluator, SDK, locks and persisted checkpoint, with every
// network request intercepted. No provider or user data is accessed.
test("Stop during accepted photo analysis saves that answer and skips later paid stages", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-evaluate-stop-"));
    for (const [name, value] of Object.entries({ POKEMON_FLIPPER_DATA_DIR: directory, OPENAI_API_KEY: "offline-stop" })) {
        const old = process.env[name]; process.env[name] = value;
        t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    }
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    offlineEbayCredentials(t);
    const id = "v1|offline-photo-cancellation|0";
    let started!: () => void, release!: () => void, paid = 0;
    const photoStarted = new Promise<void>(resolve => { started = resolve; });
    const finishPhoto = new Promise<void>(resolve => { release = resolve; });
    const reading = { ...cardEvaluation().photoCheck!, cardCount: "ONE" };
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.hostname === "api.ebay.com") return Response.json({ itemId: id, title: "Venusaur Base Set 15/102 Holo",
            itemWebUrl: "https://www.ebay.com/itm/123456789012", buyingOptions: ["FIXED_PRICE"], price: { value: "20", currency: "USD" },
            image: { imageUrl: "https://i.ebayimg.com/images/g/offline-stop/s-l1600.jpg" },
            localizedAspects: Object.entries({ Set: "Base Set", "Card Name": "Venusaur", "Card Number": "15/102" }).map(([name, value]) => ({ name, value })) });
        assert.equal(url.hostname, "api.openai.com", "no pricing stage may start after Stop");
        const request = JSON.parse(String(init?.body));
        assert.equal(request.text.format.name, "photo_check", "no condition or comp stage may start after Stop");
        paid++; started(); await finishPhoto;
        return Response.json({ id: "offline-photo", object: "response", status: "completed", output_text: JSON.stringify(reading),
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(reading), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const { evaluateListing } = await import("../../server/analysis/evaluate.ts");
    const { loadSaved } = await import("../../server/analysis/store.ts");
    const stopped = new AbortController();
    const evaluation = evaluateListing(id, { signal: stopped.signal });
    await photoStarted;
    stopped.abort();
    await assert.rejects(evaluation, { name: "AbortError" });
    release();
    let saved = await loadSaved(id);
    for (let count = 0; !saved && count < 200; count++) { await delay(5); saved = await loadSaved(id); }
    assert.deepEqual(saved?.photoCheck?.result, reading, "accepted paid evidence survives cancellation");
    assert.equal(saved?.conditionRuns, undefined);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(paid, 1);
});
