import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDevelopmentBrowseBudget, EbayDevelopmentBudgetError } from "../../server/ebay/development-budget.ts";
import { ROOT } from "../../server/lib/paths.ts";

async function temporary(t: TestContext) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-development-quota-"));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    return { folder, file: path.join(folder, "ebay-development-budget.json") };
}

test("independent development budget instances never reserve more than25 calls and a restart retains usage", async t => {
    const { file } = await temporary(t);
    await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), limit: 25, used: 0 }));
    const a = createDevelopmentBrowseBudget({ file }), b = createDevelopmentBrowseBudget({ file }); let dailyReservations = 0;
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b).reserve(async () => { dailyReservations++; })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 25);
    assert.ok(results.filter(result => result.status === "rejected").every(result => result.reason instanceof EbayDevelopmentBudgetError));
    assert.equal(dailyReservations, 25, "development rejections cannot consume daily quota reservations");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).used, 25);
    assert.equal((await b.status())?.remaining, 0);
    await assert.rejects(createDevelopmentBrowseBudget({ file }).reserve(), /development Browse limit.*25/i);
});

test("expiry disables today's development cap while missing configuration preserves normal requests", async t => {
    const { file, folder } = await temporary(t); let at = Date.now(), calls = 0;
    await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: new Date(at + 60_000).toISOString(), limit: 25, used: 25 }));
    const budget = createDevelopmentBrowseBudget({ file, now: () => at });
    await assert.rejects(budget.reserve(), /development Browse limit/i);
    at += 60_001;
    assert.equal(await budget.status(), null);
    await Promise.all(Array.from({ length: 30 }, () => budget.reserve(async () => { calls++; })));
    assert.equal(calls, 30); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).used, 25, "an expired cap does not restart or constrain the next window");
    const unconfigured = createDevelopmentBrowseBudget({ file: path.join(folder, "missing.json") });
    await unconfigured.reserve(async () => { calls++; }); assert.equal(await unconfigured.status(), null); assert.equal(calls, 31);
});

test("cached details, OAuth and Analytics do not consume the development allowance; transport rejects an extra Browse call", async t => {
    const { file, folder } = await temporary(t);
    await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), limit: 1, used: 0 }));
    const code = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { ebayGet } from './server/ebay/api.ts';
        import { ebayUsage } from './server/ebay/usage.ts';
        import { getListingDetails } from './server/ebay/listings.ts';
        let browse=0, oauth=0, analytics=0;
        globalThis.fetch=async(url)=>{
            const address=String(url);
            if(address.includes('oauth2/token')){oauth++;return Response.json({access_token:'offline',expires_in:3600});}
            if(address.includes('rate_limit')){analytics++;return Response.json({rateLimits:[{apiName:'Browse',resources:[{name:'buy.browse',rates:[{count:0,limit:5000,remaining:5000,reset:new Date(Date.now()+3600000).toISOString()}]}]}]});}
            assert.ok(address.startsWith('https://api.ebay.com/buy/browse/'));browse++;
            return Response.json({itemId:'offline-development-cache',title:'Pokemon card',buyingOptions:['FIXED_PRICE'],price:{value:'10',currency:'USD'},shippingOptions:[{shippingCost:{value:'0',currency:'USD'}}]});
        };
        await ebayUsage({fresh:true});
        const file=path.join(process.env.POKEMON_FLIPPER_DATA_DIR,'ebay-development-budget.json');
        assert.equal(JSON.parse(await fs.readFile(file,'utf8')).used,0);
        await getListingDetails('offline-development-cache');
        await getListingDetails('offline-development-cache');
        await assert.rejects(ebayGet('/buy/browse/v1/item/blocked'),/development Browse limit/i);
        const usage=await ebayUsage();
        assert.equal(usage.used,1);assert.equal(usage.devRemaining,0);assert.equal(usage.devLimit,1);
        assert.deepEqual({browse,oauth,analytics},{browse:1,oauth:1,analytics:1});
        console.log(JSON.stringify({browse,oauth,analytics,used:JSON.parse(await fs.readFile(file,'utf8')).used}));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
        cwd: ROOT, env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: folder, EBAY_CLIENT_ID: `offline-development-${path.basename(folder)}`, EBAY_CLIENT_SECRET: "offline-test-secret" },
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { browse: 1, oauth: 1, analytics: 1, used: 1 });
});

test("corrupt or unreadable development accounting fails closed before daily reservations", async t => {
    const { file } = await temporary(t); let calls = 0;
    await fs.writeFile(file, "{broken"); const budget = createDevelopmentBrowseBudget({ file });
    await assert.rejects(budget.reserve(async () => { calls++; }), /Development Browse accounting/);
    await fs.unlink(file); await fs.mkdir(file);
    await assert.rejects(budget.reserve(async () => { calls++; }), /Development Browse accounting/);
    assert.equal(calls, 0);
});

test("an old development lock is never stolen from a suspended owner", async t => {
    const { file } = await temporary(t); const lock = `${file}.lock`; let reservations = 0;
    await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), limit: 25, used: 0 }));
    await fs.writeFile(lock, "retained-owner-nonce");
    const old = new Date(Date.now() - 60_000); await fs.utimes(lock, old, old);
    let clock = Date.now(); t.mock.method(Date, "now", () => clock += 10_001);
    await assert.rejects(createDevelopmentBrowseBudget({ file }).reserve(async () => { reservations++; }), /locked.*keep the budget ledger/i);
    assert.equal(await fs.readFile(lock, "utf8"), "retained-owner-nonce");
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).used, 0); assert.equal(reservations, 0);
});

test("a protected expired development allowance blocks new reservations until explicit renewal without resetting usage", async t => {
    const { file } = await temporary(t); const at = Date.now(); let dispatched = 0;
    const ledger = { version: 1, expiresAt: new Date(at - 1).toISOString(), limit: 25, used: 7, requireRenewal: true };
    await fs.writeFile(file, JSON.stringify(ledger));
    const budget = createDevelopmentBrowseBudget({ file, now: () => at });
    await assert.rejects(budget.reserve(async () => { dispatched++; }), /expired.*renew.*used count was kept/i);
    assert.equal(dispatched, 0); assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), ledger);
    const status = await budget.status(); assert.equal(status?.remaining, 0); assert.equal(status?.renewalRequired, true);
});
