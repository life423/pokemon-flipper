import "../fixtures/mock-ai-spending.ts";
import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { cachedCompChecks, checkComps } from "../../server/ai/comp-checker.ts";
import type { Comp, CompTarget } from "../../server/pricing/types.ts";
test("reading existing comp verdicts never starts a paid request for uncached evidence", async t => {
    let files = 0, requests = 0;
    t.mock.method(fs, "readFile", async () => {
        if (files++ > 0) throw Error("uncached sale");
        return JSON.stringify({ savedAt: new Date(Date.now()).toISOString(), data: { keep: true, reason: null, note: "matches" } });
    });
    t.mock.method(globalThis, "fetch", async () => { requests++; throw Error("No paid request allowed"); });
    const sales = [1, 2].map(id => ({ id, title: `Offline card ${id}` } as Comp));
    const result = await cachedCompChecks(sales, { cardName: "Offline", setName: "Offline set", cardNumber: "1/1", printingLabel: "Unlimited", grader: "RAW", grade: "LIGHTLY_PLAYED" });
    assert.equal(result.size, 1); assert.equal(result.get(sales[0])?.keep, true);
    assert.equal(result.has(sales[1]), false); assert.equal(requests, 0);
});

test("shared comp checks preserve another consumer and save an accepted answer after all consumers stop", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    const files = new Map<string, string>(); let requests = 0; let onSaved = () => {};
    t.mock.method(fs, "readFile", async (file: unknown) => { const value = files.get(String(file)); if (!value) throw Object.assign(Error("offline cache miss"), { code: "ENOENT" }); return value; });
    t.mock.method(fs, "writeFile", async (file: unknown, data: unknown) => { files.set(String(file), String(data)); });
    t.mock.method(fs, "rename", async (source: unknown, destination: unknown) => { files.set(String(destination), files.get(String(source))!); onSaved(); });
    t.mock.method(fs, "mkdir", async () => undefined);
    t.mock.method(fs, "rm", async () => undefined);
    t.mock.method(fs, "appendFile", async () => undefined);
    const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => resolve = done), resolve: () => resolve() }; };
    let dispatch = deferred(), response = deferred();
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        assert.equal(String(url), "https://api.openai.com/v1/responses"); requests++; dispatch.resolve(); await response.promise;
        assert.equal(init?.signal?.aborted, false, "accepted paid requests finish instead of discarding their answers");
        const text = JSON.stringify({ sales: [{ line: 1, keep: true, reason: null, note: "Matches exact card" }] });
        return Response.json({ id: "offline-comp", status: "completed", output_text: text, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10 } });
    });
    const target: CompTarget = { cardName: "Offline", setName: "Offline set", cardNumber: "1/1", printingLabel: "Unlimited", grader: "RAW", grade: "LIGHTLY_PLAYED" };
    const sale = { id: "offline-shared", title: "Offline card" } as Comp;
    const stop = new AbortController();
    const canceled = assert.rejects(checkComps([sale], target, stop.signal), { name: "AbortError" });
    const clone = { ...sale }; const needed = checkComps([clone], target);
    await dispatch.promise; stop.abort(); await canceled; response.resolve();
    assert.equal((await needed).get(clone)?.keep, true); assert.equal(requests, 1);
    assert.equal((await checkComps([sale], target)).get(sale)?.keep, true); assert.equal(requests, 1, "saved verdict is reused");

    dispatch = deferred(); response = deferred(); const savedAfterStop = deferred(); onSaved = savedAfterStop.resolve;
    const both = new AbortController(); const otherSale = { ...sale, id: "offline-stopped-after-dispatch" };
    const a = assert.rejects(checkComps([otherSale], target, both.signal), { name: "AbortError" });
    const b = assert.rejects(checkComps([{ ...otherSale }], target, both.signal), { name: "AbortError" });
    await dispatch.promise; both.abort(); await Promise.all([a, b]); response.resolve(); await savedAfterStop.promise;
    assert.equal((await cachedCompChecks([otherSale], target)).get(otherSale)?.keep, true);
    assert.equal(requests, 2, "one shared accepted request is saved even after everyone stops");
});
