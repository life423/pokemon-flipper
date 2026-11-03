import "../fixtures/isolated-data.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPriceResearchBudget, PRICE_RESEARCH_LIMIT, PriceResearchBudgetError, reservePriceRequest,
    priceResearchSummary, assertPriceResearchAvailable, withPriceResearchSignal, getPriceResearchSignal } from "../../server/pricing/research-budget.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { ROOT } from "../../server/lib/paths.ts";

const execute = promisify(execFile);
const fileFor = (directory: string, id: string) => path.join(directory, `${createHash("sha256").update(id.toLowerCase()).digest("hex")}.json`);
async function temporary(t: TestContext) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-price-research-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
const isLimit = (error: unknown) => error instanceof PriceResearchBudgetError && error.reason === "LIMIT" && error.code === "PRICE_RESEARCH_BUDGET" && !error.retryable;

test("one search has64 durable attempts across instances/restarts/dates while read-only checks and cached work consume none", async t => {
    const directory = await temporary(t), searchId = randomUUID();
    const a = createPriceResearchBudget({ directory }), b = createPriceResearchBudget({ directory });
    await a.assertAvailable(searchId); await a.summary(searchId);
    assert.deepEqual(await fs.readdir(directory), [], "an availability read is not a reservation or a cache-clearing write");
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b).reserve("/cards/one/listings/ebay?limit=20", { searchId })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, PRICE_RESEARCH_LIMIT);
    assert.ok(results.filter(result => result.status === "rejected").every(result => isLimit(result.reason)));
    const before = await fs.readFile(fileFor(directory, searchId), "utf8");
    const summary = await createPriceResearchBudget({ directory, now: () => Date.now() + 30 * 86400000 }).summary(searchId.toUpperCase());
    assert.equal(summary?.used, 64); assert.equal(summary?.remaining, 0); assert.equal(summary?.pending, 64);
    assert.equal(summary?.unreportedCreditAttempts, 64); assert.equal(summary?.unreportedRowAttempts, 64);
    await assert.rejects(b.assertAvailable(searchId), isLimit);
    await assert.rejects(b.reserve("/cards/another", { searchId: searchId.toUpperCase() }), isLimit);
    assert.equal(await fs.readFile(fileFor(directory, searchId), "utf8"), before, "reads and rejected work cannot rewrite/reset the exhausted ledger");
    const other = randomUUID(); await a.reserve("/cards/one", { searchId: other });
    assert.equal((await a.summary(other))?.remaining, 63); assert.equal((await a.summary(searchId))?.used, 64);
});

test("independent processes cannot authorize a65th request under the same UUID", async t => {
    const directory = await temporary(t), searchId = randomUUID();
    const source = `import {createPriceResearchBudget} from './server/pricing/research-budget.ts';
        const b=createPriceResearchBudget({directory:process.env.PRICE_TEST_DIRECTORY});
        const r=await Promise.allSettled(Array.from({length:32},()=>b.reserve('/cards/1',{searchId:process.env.PRICE_TEST_SEARCH})));
        console.log(JSON.stringify(r.filter(x=>x.status==='fulfilled').length));`;
    const children = await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: ROOT, env: { ...process.env, PRICE_TEST_DIRECTORY: directory, PRICE_TEST_SEARCH: searchId },
    })));
    assert.equal(children.reduce((sum, child) => sum + JSON.parse(child.stdout.trim()), 0), 64);
    assert.equal((await createPriceResearchBudget({ directory }).summary(searchId))?.remaining, 0);
});

test("reported credit units, inferred rows and unknown attempts remain separate and completion is idempotent", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory }), searchId = randomUUID();
    const one = await budget.reserve("/cards/1/listings/ebay?limit=20", { searchId, listingId: "v1|123456789012|0" });
    const response = Response.json({}, { headers: { "x-credits-charged": "5", "x-credits-limit": "20000", "x-credits-remaining": "19995", "x-credits-balance": "42", "x-credits-reset": "1200", "x-rate-limit": "60", "x-rate-remaining": "59", "x-rate-reset": "10" } });
    await one.complete(response, { data: [{}, {}, {}] }); await one.complete(response, { data: [{}, {}, {}] });
    await assert.rejects(one.complete(response, { data: [] }), error => error instanceof PriceResearchBudgetError && error.reason === "STATE");
    await one.unresolved();
    const zero = await budget.reserve("/cards/2", { searchId }); await zero.complete(Response.json({}, { status: 429, headers: { "x-credits-charged": "0" } }), { data: [] });
    const missing = await budget.reserve("/sets", { searchId }); await missing.complete(Response.json({}), { data: [{}, {}] });
    const pending = await budget.reserve("/cards/3", { searchId });
    const failed = await budget.reserve("/cards/4", { searchId }); await failed.unresolved(); await failed.unresolved();
    const summary = await budget.summary(searchId);
    assert.deepEqual(summary, { searchId, limit: 64, used: 5, remaining: 59, completed: 3, pending: 1, unresolved: 1,
        reportedCredits: 5, unreportedCreditAttempts: 3, returnedRows: 5, unreportedRowAttempts: 2,
        provider: { limit: 20000, remaining: 19995, balance: 42, resetSeconds: 1200 } });
    await failed.complete(Response.json({}, { headers: { "x-credits-charged": "1", "x-credits-remaining": "19999" } }), { id: 4, name: "metadata record" });
    assert.equal((await budget.summary(searchId))?.unresolved, 0, "a late known response can resolve an unknown attempt without buying another request");
    assert.equal((await budget.summary(searchId))?.provider?.remaining, 19999, "retain the actual latest observed value without projecting a balance");
    await pending.complete(Response.json({}), { data: { id: "one", number: "4/102" } });
    assert.equal((await budget.summary(searchId))?.returnedRows, 7);
});

test("ledger stores hashed request targets and safe numeric counters, never payloads, raw paths or credentials", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory }), searchId = randomUUID();
    const secretPath = "/cards/private-card/listings/ebay?key=PRIVATE-QUERY&name=PRIVATE-SELLER-TITLE";
    const reservation = await budget.reserve(secretPath, { searchId, listingId: "v1|123456789012|0" });
    await reservation.complete(Response.json({}, { headers: { "x-credits-charged": "2", "x-credits-remaining": "bad", "x-credits-limit": "Infinity", "x-credits-balance": "-1", "x-rate-reset": "1.5", authorization: "PRIVATE-AUTH", "set-cookie": "PRIVATE-COOKIE" } }),
        { data: [{ name: "PRIVATE-PAYLOAD", price: 999999 }] });
    const text = await fs.readFile(fileFor(directory, searchId), "utf8"), ledger = JSON.parse(text);
    assert.match(ledger.attempts[0].requestHash, /^[a-f0-9]{64}$/); assert.equal(ledger.attempts[0].endpoint, "SOLD_LISTINGS");
    assert.deepEqual(ledger.attempts[0].headers, { "x-credits-charged": 2 });
    for (const secret of ["PRIVATE", "private-card", "999999", "authorization", "set-cookie", "/cards/"]) assert.equal(text.includes(secret), false);
    const summary = await budget.summary(searchId); assert.equal(summary?.provider, null); assert.equal(summary?.reportedCredits, 2); assert.equal(summary?.returnedRows, 1);
});

test("last observed account headers follow completion order even at identical timestamps", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory, now: () => 1_700_000_000_000 }), searchId = randomUUID();
    const one = await budget.reserve("/cards/1", { searchId }), two = await budget.reserve("/cards/2", { searchId });
    await one.complete(Response.json({}, { headers: { "x-credits-remaining": "100" } }), { data: [] });
    await two.complete(Response.json({}, { headers: { "x-credits-remaining": "99" } }), { data: [] });
    assert.equal((await budget.summary(searchId))?.provider?.remaining, 99);
    await one.complete(Response.json({}, { headers: { "x-credits-remaining": "100" } }), { data: [] });
    assert.equal((await budget.summary(searchId))?.provider?.remaining, 99, "an idempotent reopen does not make an older response fresh");
});

test("invalid scopes, endpoints and corrupt/unreadable ledgers fail closed without reservations", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory }), searchId = randomUUID();
    for (const id of [undefined, "", "../search", "not-a-uuid", "x".repeat(81)]) await assert.rejects(budget.reserve("/cards", { searchId: id }), error => error instanceof PriceResearchBudgetError && error.reason === "SCOPE");
    for (const endpoint of ["https://example.com/private", "//example.com/private", "/cards\\private", "/cards\nprivate"]) await assert.rejects(budget.reserve(endpoint, { searchId }), error => error instanceof PriceResearchBudgetError && error.reason === "STATE");
    assert.deepEqual(await fs.readdir(directory), []);
    const base = { version: 1, searchId, limit: 64, attempts: [] };
    for (const value of ["{bad-json", JSON.stringify({ ...base, limit: 16 }), JSON.stringify({ ...base, searchId: randomUUID() }),
        JSON.stringify({ ...base, version: 2 }), JSON.stringify({ ...base, attempts: [{}] }), JSON.stringify({ ...base, unexpectedPayload: "kept" })]) {
        await fs.writeFile(fileFor(directory, searchId), value);
        await assert.rejects(budget.reserve("/cards/1", { searchId }), PriceResearchBudgetError);
        assert.equal(await fs.readFile(fileFor(directory, searchId), "utf8"), value);
    }
    const unreadable = randomUUID(); await fs.mkdir(fileFor(directory, unreadable));
    await assert.rejects(budget.assertAvailable(unreadable), error => error instanceof PriceResearchBudgetError && error.reason === "STORAGE");
});

test("cancelled work never reserves, accepted responses can still settle, and retained locks are not stolen", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory }), searchId = randomUUID();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(budget.reserve("/cards/1", { searchId }, controller.signal), { name: "AbortError" });
    assert.equal((await budget.summary(searchId))?.used, 0);
    const live = new AbortController(), accepted = await budget.reserve("/cards/1", { searchId }, live.signal); live.abort();
    await accepted.complete(Response.json({}, { headers: { "x-credits-charged": "1" } }), { data: [] });
    assert.equal((await budget.summary(searchId))?.completed, 1);
    const lockedId = randomUUID(), lock = fileFor(directory, lockedId) + ".lock"; await fs.writeFile(lock, "retained-owner");
    const past = new Date(Date.now() - 86400000); await fs.utimes(lock, past, past);
    let clock = Date.now(); t.mock.method(Date, "now", () => clock += 10_001);
    await assert.rejects(budget.reserve("/cards/1", { searchId: lockedId }), error => error instanceof PriceResearchBudgetError && error.reason === "LOCK");
    assert.equal(await fs.readFile(lock, "utf8"), "retained-owner"); assert.equal((await budget.summary(lockedId))?.used, 0);
});

test("failed accounting writes authorize no transport and invalid response status cannot corrupt a reservation", async t => {
    const directory = await temporary(t), budget = createPriceResearchBudget({ directory }), searchId = randomUUID();
    const write = fs.writeFile;
    const mock = t.mock.method(fs, "writeFile", async (file, ...args) => {
        if (String(file).startsWith(directory) && String(file).endsWith(".tmp")) throw Object.assign(new Error("offline write failure"), { code: "EIO" });
        return write(file, ...args);
    });
    await assert.rejects(budget.reserve("/cards/1", { searchId }), error => error instanceof PriceResearchBudgetError && error.reason === "STORAGE");
    assert.equal((await budget.summary(searchId))?.used, 0);
    assert.deepEqual(await fs.readdir(directory), [], "an unsuccessful reservation leaves no leaked lock or partial ledger");
    mock.mock.restore();
    const pending = await budget.reserve("/cards/1", { searchId });
    await assert.rejects(pending.complete(Response.error(), {}), error => error instanceof PriceResearchBudgetError && error.reason === "STATE");
    assert.equal((await budget.summary(searchId))?.pending, 1);
    await pending.unresolved(); assert.equal((await budget.summary(searchId))?.unresolved, 1);
});

test("default API preserves scope/signal, fails closed without a key, and namespaces separate configured keys locally", async t => {
    const old = process.env.PKMNPRICES_API_KEY;
    t.after(() => { if (old === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = old; });
    delete process.env.PKMNPRICES_API_KEY;
    assert.equal(await priceResearchSummary(), null);
    assert.throws(() => reservePriceRequest("/cards"), error => error instanceof PriceResearchBudgetError && error.reason === "SCOPE");
    const searchId = randomUUID();
    await withAiUsageContext({ searchId }, async () => {
        assert.throws(() => reservePriceRequest("/cards"), error => error instanceof PriceResearchBudgetError && error.reason === "ACCOUNT");
        process.env.PKMNPRICES_API_KEY = "offline-namespace-one";
        const cancelled = new AbortController(); cancelled.abort();
        await withPriceResearchSignal(cancelled.signal, async () => {
            assert.equal(getPriceResearchSignal(), cancelled.signal);
            assert.throws(() => reservePriceRequest("/cards"), { name: "AbortError" });
        });
        assert.equal(getPriceResearchSignal(), undefined);
        await assertPriceResearchAvailable(); assert.equal((await priceResearchSummary())?.used, 0);
        const request = await reservePriceRequest("/cards/1"); await request.unresolved();
        assert.equal((await priceResearchSummary())?.used, 1);
        process.env.PKMNPRICES_API_KEY = "offline-namespace-two";
        assert.equal((await priceResearchSummary())?.used, 0);
        process.env.PKMNPRICES_API_KEY = "offline-namespace-one";
        assert.equal((await priceResearchSummary())?.unresolved, 1);
    });
});
