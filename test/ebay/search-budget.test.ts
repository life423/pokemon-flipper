import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSearchBrowseBudget, EbaySearchBudgetError } from "../../server/ebay/search-budget.ts";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { ROOT } from "../../server/lib/paths.ts";

async function temporary(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-search-quota-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
const execute = promisify(execFile);
const fileFor = (directory: string, id: string) => path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);

test("each new search has50 calls shared by independent instances; restarts and later dates cannot refill it", async t => {
    const directory = await temporary(t), a = createSearchBrowseBudget({ directory }), b = createSearchBrowseBudget({ directory });
    let daily = 0;
    const requests = await Promise.allSettled(Array.from({ length: 100 }, (_, n) => (n % 2 ? a : b).reserve("search-one", async () => { daily++; })));
    assert.equal(requests.filter(result => result.status === "fulfilled").length, 50);
    assert.ok(requests.filter(result => result.status === "rejected").every(result => result.reason instanceof EbaySearchBudgetError));
    assert.equal(daily, 50, "search rejection must not spend the daily allowance");
    assert.deepEqual(await createSearchBrowseBudget({ directory }).status("search-one"), { searchId: "search-one", limit: 50, used: 50, remaining: 0 });
    const at = Date.now(); t.mock.method(Date, "now", () => at + 30 * 86400000);
    await assert.rejects(b.reserve("search-one", async () => { daily++; }), /50-request.*cap/);
    await a.reserve("search-two", async () => { daily++; });
    assert.deepEqual(await a.status("search-two"), { searchId: "search-two", limit: 50, used: 1, remaining: 49 });
    assert.equal((await b.status("search-one"))?.used, 50); assert.equal(daily, 51);
});

test("separate processes share the same search cap without permitting a51st reservation", async t => {
    const directory = await temporary(t);
    const source = `import {createSearchBrowseBudget} from './server/ebay/search-budget.ts';
        const budget=createSearchBrowseBudget({directory:process.env.SEARCH_TEST_DIRECTORY});
        const result=await Promise.allSettled(Array.from({length:20},()=>budget.reserve('shared-search',async()=>{})));
        console.log(JSON.stringify(result.filter(r=>r.status==='fulfilled').length));`;
    const output = await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, env: { ...process.env, SEARCH_TEST_DIRECTORY: directory },
    })));
    assert.equal(output.reduce((sum, value) => sum + JSON.parse(value.stdout.trim()), 0), 50);
    assert.equal((await createSearchBrowseBudget({ directory }).status("shared-search"))?.remaining, 0);
});

test("existing25-call searches retain their counters and cap while new searches receive50", async t => {
    const directory = await temporary(t), budget = createSearchBrowseBudget({ directory });
    const partial = { version: 1, searchId: "legacy-partial", limit: 25, used: 24 };
    const exhausted = { version: 1, searchId: "legacy-exhausted", limit: 25, used: 25 };
    await fs.writeFile(fileFor(directory, partial.searchId), JSON.stringify(partial));
    const exhaustedBytes = JSON.stringify(exhausted);
    await fs.writeFile(fileFor(directory, exhausted.searchId), exhaustedBytes);
    assert.deepEqual(await budget.status(partial.searchId), { searchId: partial.searchId, limit: 25, used: 24, remaining: 1 });
    assert.equal(await fs.readFile(fileFor(directory, partial.searchId), "utf8"), JSON.stringify(partial), "reading an old allowance must not migrate or widen it");
    let daily = 0;
    await budget.reserve(partial.searchId, async () => { daily++; });
    const reopened = createSearchBrowseBudget({ directory });
    assert.deepEqual(await reopened.status(partial.searchId), { searchId: partial.searchId, limit: 25, used: 25, remaining: 0 });
    const at = Date.now(); t.mock.method(Date, "now", () => at + 30 * 86400000);
    for (const id of [partial.searchId, exhausted.searchId]) await assert.rejects(reopened.reserve(id, async () => { daily++; }), /25-request.*cap/);
    assert.equal(daily, 1, "old exhausted searches cannot spend daily quota after the default increases");
    assert.equal(await fs.readFile(fileFor(directory, exhausted.searchId), "utf8"), exhaustedBytes, "a rejected old search retains its original ledger bytes");
    await reopened.reserve("new-allowance", async () => { daily++; });
    assert.deepEqual(await reopened.status("new-allowance"), { searchId: "new-allowance", limit: 50, used: 1, remaining: 49 });
});

test("invalid or corrupt search accounting and cancellation fail closed before daily reservations", async t => {
    const directory = await temporary(t), budget = createSearchBrowseBudget({ directory }); let daily = 0;
    for (const id of [undefined, "", "../other", "x".repeat(81)]) {
        assert.throws(() => budget.reserve(id, async () => { daily++; }), /valid search ID/);
    }
    for (const value of ["{broken", ...[0, 26, 49, 51, "50"].map(limit => JSON.stringify({ version: 1, searchId: "corrupt", limit, used: 0 })),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 25, used: -1 }),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 25, used: 26 }),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 50, used: 51 }),
        JSON.stringify({ version: 1, searchId: "other-search", limit: 25, used: 0 })]) {
        await fs.writeFile(fileFor(directory, "corrupt"), value);
        await assert.rejects(budget.reserve("corrupt", async () => { daily++; }), /accounting/);
    }
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(budget.reserve("stopped", async () => { daily++; }, stopped.signal), { name: "AbortError" });
    await fs.mkdir(fileFor(directory, "unreadable"));
    await assert.rejects(budget.reserve("unreadable", async () => { daily++; }), /accounting could not be read/);
    await assert.rejects(budget.reserve("daily-denied", async () => { throw new EbayBudgetError("daily denied"); }), /daily denied/);
    assert.equal((await budget.status("daily-denied"))?.used, 0);
    assert.equal(daily, 0);
});

test("a retained lease is never stolen to refill a blocked search", async t => {
    const directory = await temporary(t), file = fileFor(directory, "locked");
    await fs.writeFile(`${file}.lock`, "retained-owner");
    const past = new Date(Date.now() - 86400000); await fs.utimes(`${file}.lock`, past, past);
    let clock = Date.now(); t.mock.method(Date, "now", () => clock += 10001);
    await assert.rejects(createSearchBrowseBudget({ directory }).reserve("locked", async () => assert.fail("no daily reservation")), /locked.*keep its budget ledger/);
    assert.equal(await fs.readFile(`${file}.lock`, "utf8"), "retained-owner");
});

test("actual mocked transport counts nested Browse calls by search, reuses caches and ignores the obsolete global expiry", async t => {
    const directory = await temporary(t);
    const source = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import {ebayGet} from './server/ebay/api.ts';
        import {ebayUsage} from './server/ebay/usage.ts';
        import {getListingDetails} from './server/ebay/listings.ts';
        import {withAiUsageContext} from './server/ai/usage-context.ts';
        const oldFile=path.join(process.env.POKEMON_FLIPPER_DATA_DIR,'ebay-development-budget.json');
        const oldLedger={version:1,expiresAt:'2020-01-01T00:00:00.000Z',limit:25,used:23,requireRenewal:true};
        await fs.writeFile(oldFile,JSON.stringify(oldLedger));
        let browse=0,oauth=0,analytics=0;
        globalThis.fetch=async(url)=>{
            const address=String(url);
            if(address.includes('oauth2/token')){oauth++;return Response.json({access_token:'offline',expires_in:3600});}
            if(address.includes('rate_limit')){analytics++;return Response.json({rateLimits:[{apiName:'Browse',resources:[{name:'buy.browse',rates:[{count:0,limit:5000,remaining:5000,reset:new Date(Date.now()+3600000).toISOString()}]}]}]});}
            assert.ok(address.startsWith('https://api.ebay.com/buy/browse/'));browse++;
            return Response.json({itemId:'offline-search-cache',title:'Pokemon card',buyingOptions:['FIXED_PRICE'],price:{value:'10',currency:'USD'},shippingOptions:[{shippingCost:{value:'0',currency:'USD'}}]});
        };
        await assert.rejects(ebayGet('/buy/browse/v1/item/no-scope'),/valid search ID/);
        assert.equal(oauth,0,'missing IDs must fail before even OAuth');
        await ebayUsage({fresh:true});
        await withAiUsageContext({searchId:'search-one'},async()=>{
            await getListingDetails('offline-search-cache');
            await getListingDetails('offline-search-cache');
            await withAiUsageContext({listingId:'nested'},async()=>{
                for(let i=0;i<49;i++)await ebayGet('/buy/browse/v1/item/nested-'+i);
            });
            await assert.rejects(ebayGet('/buy/browse/v1/item/blocked'),/50-request.*cap/);
            const usage=await ebayUsage();assert.equal(usage.used,50);
            assert.deepEqual(usage.searchBudget,{searchId:'search-one',limit:50,used:50,remaining:0});
        });
        await withAiUsageContext({searchId:'search-two'},async()=>{
            await ebayGet('/buy/browse/v1/item/new-search');
            const usage=await ebayUsage();assert.equal(usage.used,51);assert.equal(usage.searchBudget.remaining,49);
        });
        await withAiUsageContext({searchId:'search-one'},async()=>{
            await assert.rejects(ebayGet('/buy/browse/v1/item/still-blocked'),/50-request.*cap/);
        });
        assert.deepEqual(JSON.parse(await fs.readFile(oldFile,'utf8')),oldLedger,'historical counts must stay untouched');
        assert.deepEqual({browse,oauth,analytics},{browse:51,oauth:1,analytics:1});
        console.log(JSON.stringify({browse,oauth,analytics}));
    `;
    const output = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: directory, POKEMON_FLIPPER_STORAGE: "file", EBAY_CLIENT_ID: `offline-search-${path.basename(directory)}`, EBAY_CLIENT_SECRET: "offline-test-secret" },
    });
    assert.deepEqual(JSON.parse(output.stdout.trim()), { browse: 51, oauth: 1, analytics: 1 });
});
