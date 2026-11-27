import "../fixtures/isolated-data.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSearchBrowseBudget, EBAY_SEARCH_BROWSE_LIMIT } from "../../server/ebay/search-budget.ts";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { ROOT } from "../../server/lib/paths.ts";

async function temporary(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-search-quota-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
const execute = promisify(execFile);
const fileFor = (directory: string, id: string) => path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
const usage = (searchId: string, used: number, historicalLimit: number | null = null) =>
    ({ searchId, used, limit: null, remaining: null, policy: "daily-reserve", historicalLimit });

test("independent instances retain all reservations beyond the former search cap", async t => {
    const directory = await temporary(t), a = createSearchBrowseBudget({ directory }), b = createSearchBrowseBudget({ directory });
    const requests = EBAY_SEARCH_BROWSE_LIMIT + 4;
    let daily = 0;
    await Promise.all(Array.from({ length: requests }, (_, n) => (n % 2 ? a : b).reserve("search-one", async () => { daily++; })));
    assert.equal(daily, requests);
    assert.deepEqual(await createSearchBrowseBudget({ directory }).status("search-one"), usage("search-one", requests));
    await a.reserve("search-two", async () => { daily++; });
    assert.deepEqual(await a.status("search-two"), usage("search-two", 1));
    assert.equal((await b.status("search-one"))?.used, requests);
    assert.equal(daily, requests + 1);
});

test("separate processes append to the same search's request count using its original ID", async t => {
    const directory = await temporary(t);
    const source = `import {createSearchBrowseBudget} from './server/ebay/search-budget.ts';
        const budget=createSearchBrowseBudget({directory:process.env.SEARCH_TEST_DIRECTORY});
        await Promise.all(Array.from({length:20},()=>budget.reserve('shared-search',async()=>{})));`;
    await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, env: { ...process.env, SEARCH_TEST_DIRECTORY: directory },
    })));
    assert.deepEqual(await createSearchBrowseBudget({ directory }).status("shared-search"), usage("shared-search", 60));
});

test("exhausted 25-, 50- and 100-call records keep original usage and legacy limits through migration", async t => {
    const directory = await temporary(t), budget = createSearchBrowseBudget({ directory });
    let daily = 0;
    const reopened = createSearchBrowseBudget({ directory });
    for (const limit of [25, 50, EBAY_SEARCH_BROWSE_LIMIT]) {
        const searchId = `legacy-${limit}`;
        const legacy = JSON.stringify({ version: 1, searchId, limit, used: limit });
        const file = fileFor(directory, searchId);
        await fs.writeFile(file, legacy);
        assert.deepEqual(await budget.status(searchId), usage(searchId, limit, limit));
        await assert.rejects(budget.reserve(searchId, async () => { throw new EbayBudgetError("Daily reserve", "QUOTA"); }),
            { code: "EBAY_DAILY_BUDGET" });
        assert.equal(await fs.readFile(file, "utf8"), legacy, "reading or rejecting a request leaves legacy evidence byte-for-byte");
        await budget.reserve(searchId, async () => { daily++; });
        await reopened.reserve(searchId, async () => { daily++; });
        assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
            version: 2, searchId, limit: null, historicalLimit: limit, policy: "daily-reserve", used: limit + 2,
        });
        assert.deepEqual(await reopened.status(searchId), usage(searchId, limit + 2, limit));
    }
    assert.equal(daily, 6);
});

test("invalid or corrupt search accounting and cancellation fail closed before daily reservations", async t => {
    const directory = await temporary(t), budget = createSearchBrowseBudget({ directory }); let daily = 0;
    for (const id of [undefined, "", "../other", "x".repeat(81)]) {
        assert.throws(() => budget.reserve(id, async () => { daily++; }), /valid search ID/);
    }
    for (const value of ["{broken", ...[0, 26, 49, 51, 99, 101, "50", "100"].map(limit => JSON.stringify({ version: 1, searchId: "corrupt", limit, used: 0 })),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 25, used: -1 }),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 25, used: 26 }),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: 50, used: 51 }),
        JSON.stringify({ version: 1, searchId: "corrupt", limit: EBAY_SEARCH_BROWSE_LIMIT, used: EBAY_SEARCH_BROWSE_LIMIT + 1 }),
        JSON.stringify({ version: 1, searchId: "other-search", limit: 25, used: 0 }),
        JSON.stringify({ version: 2, searchId: "corrupt", limit: null, policy: "daily-reserve", historicalLimit: 99, used: 101 }),
        JSON.stringify({ version: 2, searchId: "corrupt", limit: null, policy: "other-policy", historicalLimit: null, used: 101 })]) {
        await fs.writeFile(fileFor(directory, "corrupt"), value);
        await assert.rejects(budget.reserve("corrupt", async () => { daily++; }), /accounting/);
    }
    await fs.writeFile(fileFor(directory, "counter-full"), JSON.stringify({
        version: 2, searchId: "counter-full", limit: null, policy: "daily-reserve", historicalLimit: null, used: Number.MAX_SAFE_INTEGER,
    }));
    await assert.rejects(budget.reserve("counter-full", async () => { daily++; }), { code: "EBAY_BUDGET_ACCOUNTING" });
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
        import {withProviderContext} from './server/lib/provider-context.ts';
        import {EBAY_SEARCH_BROWSE_LIMIT} from './server/ebay/search-budget.ts';
        const oldFile=path.join(process.env.POKEMON_FLIPPER_DATA_DIR,'ebay-development-budget.json');
        const oldLedger={version:1,expiresAt:'2020-01-01T00:00:00.000Z',limit:25,used:23,requireRenewal:true};
        await fs.writeFile(oldFile,JSON.stringify(oldLedger));
        let browse=0,oauth=0,analytics=0,nearReserve=false;
        globalThis.fetch=async(url)=>{
            const address=String(url);
            if(address.includes('oauth2/token')){oauth++;return Response.json({access_token:'offline',expires_in:3600});}
            if(address.includes('rate_limit')){analytics++;return Response.json({rateLimits:[{apiName:'Browse',resources:[{name:'buy.browse',rates:[{count:nearReserve?17999:0,limit:20000,remaining:nearReserve?2001:20000,reset:new Date(Date.now()+3600000).toISOString()}]}]}]});}
            assert.ok(address.startsWith('https://api.ebay.com/buy/browse/'));browse++;
            return Response.json({itemId:'offline-search-cache',title:'Pokemon card',buyingOptions:['FIXED_PRICE'],price:{value:'10',currency:'USD'},shippingOptions:[{shippingCost:{value:'0',currency:'USD'}}]});
        };
        await assert.rejects(ebayGet('/buy/browse/v1/item/no-scope'),/valid search ID/);
        assert.equal(oauth,0,'missing IDs must fail before even OAuth');
        await ebayUsage({fresh:true});
        await withProviderContext({searchId:'search-one'},async()=>{
            await getListingDetails('offline-search-cache');
            await getListingDetails('offline-search-cache');
            await withProviderContext({listingId:'nested'},async()=>{
                for(let i=0;i<EBAY_SEARCH_BROWSE_LIMIT;i++)await ebayGet('/buy/browse/v1/item/nested-'+i);
            });
            const usage=await ebayUsage();assert.equal(usage.used,EBAY_SEARCH_BROWSE_LIMIT+1);
            assert.deepEqual(usage.searchBudget,{searchId:'search-one',limit:null,used:EBAY_SEARCH_BROWSE_LIMIT+1,remaining:null,policy:'daily-reserve',historicalLimit:null});
        });
        await withProviderContext({searchId:'search-two'},async()=>{
            await ebayGet('/buy/browse/v1/item/new-search');
            const usage=await ebayUsage();assert.equal(usage.used,EBAY_SEARCH_BROWSE_LIMIT+2);assert.equal(usage.searchBudget.used,1);
        });
        await withProviderContext({searchId:'search-one'},async()=>{
            nearReserve=true;
            await ebayUsage({fresh:true});
            await ebayGet('/buy/browse/v1/item/final-above-reserve');
            await assert.rejects(ebayGet('/buy/browse/v1/item/reserve-blocked'),{code:'EBAY_DAILY_BUDGET'});
            const usage=await ebayUsage();assert.equal(usage.remaining,2000);assert.equal(usage.braking,true);
            assert.equal((await getListingDetails('offline-search-cache')).id,'offline-search-cache');
            assert.equal(usage.searchBudget.used,EBAY_SEARCH_BROWSE_LIMIT+2);
        });
        await withProviderContext({searchId:'search-three'},()=>assert.rejects(
            ebayGet('/buy/browse/v1/item/still-blocked',{keepReserve:true}),{code:'EBAY_DAILY_BUDGET'}));
        assert.deepEqual(JSON.parse(await fs.readFile(oldFile,'utf8')),oldLedger,'historical counts must stay untouched');
        assert.deepEqual({browse,oauth,analytics},{browse:EBAY_SEARCH_BROWSE_LIMIT+3,oauth:1,analytics:2});
        console.log(JSON.stringify({browse,oauth,analytics}));
    `;
    const output = await execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: directory, POKEMON_FLIPPER_STORAGE: "file", EBAY_CLIENT_ID: `offline-search-${path.basename(directory)}`, EBAY_CLIENT_SECRET: "offline-test-secret" },
    });
    assert.deepEqual(JSON.parse(output.stdout.trim()), { browse: EBAY_SEARCH_BROWSE_LIMIT + 3, oauth: 1, analytics: 2 });
});

test("two automatic grading-watch scans consume the same persisted Browse allowance", async () => {
    const { randomUUID } = await import("node:crypto");
    const { withProviderContext } = await import("../../server/lib/provider-context.ts");
    const { reserveSearchBrowseRequest, browseSearchAllowance } = await import("../../server/ebay/search-budget.ts");
    const owner = randomUUID(), ids = [randomUUID(), randomUUID()];
    for (const searchId of ids) await withProviderContext({ searchId, watchBudgetId: owner }, () =>
        reserveSearchBrowseRequest(async () => {}));
    const ownerBudget = await withProviderContext({ searchId: owner }, browseSearchAllowance);
    assert.equal(ownerBudget?.used, 2);
    for (const searchId of ids) assert.equal((await withProviderContext({ searchId }, browseSearchAllowance))?.used, 0);
});
