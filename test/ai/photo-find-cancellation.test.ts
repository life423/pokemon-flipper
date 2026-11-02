import "../fixtures/mock-ai-spending.ts";
import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { inspectCardPhoto } from "../../server/ai/photo-find.ts";

test("discovery photo consumers stop independently and a restarted search reuses an accepted answer", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    const files = new Map<string, string>();
    t.mock.method(fs, "readFile", async (file: unknown) => { const value = files.get(String(file)); if (!value) throw Object.assign(Error("offline cache miss"), { code: "ENOENT" }); return value; });
    t.mock.method(fs, "writeFile", async (file: unknown, value: unknown) => { files.set(String(file), String(value)); });
    t.mock.method(fs, "rename", async (from: unknown, to: unknown) => { files.set(String(to), files.get(String(from))!); });
    t.mock.method(fs, "mkdir", async () => undefined); t.mock.method(fs, "rm", async () => undefined); t.mock.method(fs, "appendFile", async () => undefined);
    const deferred = () => { let done!: () => void; return { promise: new Promise<void>(resolve => done = resolve), resolve: () => done() }; };
    let ready = deferred(), response = deferred(), requests = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        assert.equal(String(url), "https://api.openai.com/v1/responses"); requests++; ready.resolve(); await response.promise;
        assert.equal(init?.signal?.aborted, false, "Stop must preserve the accepted paid response");
        const text = JSON.stringify({ cardCount: 1, isStockImage: false, card: { name: "Machop", set: "Base Set", cardNumber: "52/102", language: "English", finish: "NON_HOLO", confidence: "HIGH", evidence: ["Legible name and collector number"] }, printingMarks: { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" }, shows: "Machop" });
        return Response.json({ id: "offline-photo", status: "completed", output_text: text, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10 } });
    });
    const stop = new AbortController(); const image = "https://i.ebayimg.com/images/g/offline-shared/s-l1600.jpg";
    const canceled = assert.rejects(inspectCardPhoto(image, stop.signal), { name: "AbortError" });
    const needed = inspectCardPhoto(image);
    await ready.promise; stop.abort(); await canceled; response.resolve();
    assert.equal((await needed)?.card.name, "Machop"); assert.equal(requests, 1);
    ready = deferred(); response = deferred(); const all = new AbortController();
    const otherImage = "https://i.ebayimg.com/images/g/offline-restarted/s-l1600.jpg";
    const rejected = assert.rejects(inspectCardPhoto(otherImage, all.signal), { name: "AbortError" });
    await ready.promise; all.abort(); await rejected;
    const restarted = inspectCardPhoto(otherImage); response.resolve();
    assert.equal((await restarted)?.card.name, "Machop"); assert.equal(requests, 2, "restart waits for the first request to save before reading the cache");
});
