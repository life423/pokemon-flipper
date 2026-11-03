import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { storageFailure } from "../../server/lib/storage-failure.ts";
import { evaluationFailure } from "../../server/analysis/failure.ts";

const execute = promisify(execFile);
function unavailableConfiguration(t: { after(run: () => void): void }) {
    const values: Record<string, string | undefined> = {
        POKEMON_FLIPPER_STORAGE: "azure-sql", AZURE_SQL_SERVER: undefined, AZURE_SQL_DATABASE: undefined,
        AZURE_SQL_AUTH: "azure-cli", OPENAI_API_KEY: "offline-storage-gate", PKMNPRICES_API_KEY: "offline-storage-gate",
        EBAY_CLIENT_ID: "offline-storage-gate", EBAY_CLIENT_SECRET: "offline-storage-gate",
    };
    for (const [name, value] of Object.entries(values)) {
        const previous = process.env[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    }
}

test("eBay's direct transport blocks before OAuth or quota consumption when SQL is unavailable", async t => {
    unavailableConfiguration(t);
    const before = await fs.readdir(DATA_DIR);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No provider network is allowed"); });
    const { ebayGet } = await import("../../server/ebay/api.ts");
    for (const request of ["/buy/browse/v1/item_summary/search?q=offline", "/developer/analytics/v1_beta/rate_limit/"]) {
        await assert.rejects(ebayGet(request), { code: "STORAGE_UNAVAILABLE" });
    }
    assert.equal(calls, 0, "even OAuth must not run when saved evidence cannot be trusted");
    assert.deepEqual(await fs.readdir(DATA_DIR), before, "provider quota/spending files remain untouched");
});

test("AI's transport and real SDK refuse SQL outages even with a permissive spending mock", async t => {
    unavailableConfiguration(t);
    let calls = 0, reservations = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No provider network is allowed"); });
    const { aiSpending } = await import("../../server/ai/spending.ts");
    t.mock.method(aiSpending, "reserve", async () => { reservations++; return null; });
    const { trackedAiFetch } = await import("../../server/ai/usage.ts");
    const { runStructured } = await import("../../server/ai/openai.ts");
    await assert.rejects(trackedAiFetch("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({
        model: "offline-model", input: [], metadata: { app_step: "Offline SQL provider gate" },
    }) }), { code: "STORAGE_UNAVAILABLE" });
    await assert.rejects(runStructured({ step: "Offline SQL provider gate", prompt: "Offline fixture", photos: [],
        schemaName: "search_intent", schema: { type: "object", properties: {}, additionalProperties: false } }), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(calls, 0);
    assert.equal(reservations, 0, "a SQL failure must stop before spending work and must not be retried by the SDK");
});

test("price lookup cache outages cannot become replacement paid requests", async t => {
    unavailableConfiguration(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No provider network is allowed"); });
    const { fetchRawComps } = await import("../../server/pricing/pkmnprices.ts");
    await assert.rejects(fetchRawComps("offline-storage-outage", "Unlimited Holo"), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(calls, 0);
});

test("price lookup's final dispatch gate survives a mocked cache miss", async () => {
    // Run module injection in an isolated Node process: the real pricing adapter
    // receives a confirmed mock miss, then its final SQL gate must still block.
    const cacheUrl = new URL("../../server/lib/cache.ts", import.meta.url).href;
    const pricingUrl = new URL("../../server/pricing/pkmnprices.ts", import.meta.url).href;
    const source = `
        import { mock } from 'node:test';
        import assert from 'node:assert/strict';
        process.env.POKEMON_FLIPPER_STORAGE='azure-sql';
        delete process.env.AZURE_SQL_SERVER; delete process.env.AZURE_SQL_DATABASE;
        process.env.PKMNPRICES_API_KEY='offline-final-gate';
        let calls=0, misses=0;
        mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Provider dispatch must be blocked');});
        mock.module(${JSON.stringify(cacheUrl)},{namedExports:{
            readCache:async()=>{misses++;return null;},
            writeCache:async()=>{throw new Error('No provider result may be saved');}
        }});
        const { fetchRawComps }=await import(${JSON.stringify(pricingUrl)});
        await assert.rejects(fetchRawComps('offline-bypassed-cache','Unlimited Holo'),{code:'STORAGE_UNAVAILABLE'});
        assert.equal(calls,0); assert.equal(misses,1);
        console.log(JSON.stringify({calls,misses}));
    `;
    const result = await execute(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", source], {
        cwd: new URL("../../", import.meta.url), env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: DATA_DIR }, timeout: 20_000,
    });
    assert.deepEqual(JSON.parse(result.stdout.trim()), { calls: 0, misses: 1 });
});

test("wrapped storage errors remain a nonretryable storage stop", () => {
    const storage = new StorageUnavailableError("Offline saved evidence unavailable");
    const wrapped = new Error("SDK connection failed", { cause: new Error("Transport wrapper", { cause: storage }) });
    assert.equal(storageFailure(wrapped), storage);
    assert.deepEqual(evaluationFailure(wrapped), { status: 503, code: "STORAGE_UNAVAILABLE", error: storage.message, retryable: false });
    const serialized = { code: "STORAGE_UNAVAILABLE", message: "untrusted internal payload" };
    assert.equal(storageFailure(new Error("wrapper", { cause: serialized }))?.code, "STORAGE_UNAVAILABLE");
    assert.equal(evaluationFailure(new Error("wrapper", { cause: serialized })).retryable, false);
    const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
    assert.equal(storageFailure(cyclic), null, "a malformed SDK cause chain cannot hang the error handler");
});
