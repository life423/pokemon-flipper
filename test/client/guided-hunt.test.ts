import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { ApiRequestError, newWatchScanId, runDealHunt } from "../../client/src/api.ts";
import { independentHuntFailure, runGuidedHuntLegs, type GuidedHuntLeg } from "../../client/src/search/guided-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";

const legs: GuidedHuntLeg[] = [{ id: "fixed", format: "FIXED_PRICE", started: 1 }, { id: "auction", format: "AUCTION", started: 1 }];
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

test("Both starts independent format checks immediately; an ordinary temporary leg failure does not abandon the other", async () => {
    const fixed = deferred<string>(), auction = deferred<string>();
    const started: string[] = [], results: string[] = [], failures: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
        run: leg => { started.push(leg.id); return leg.format === "AUCTION" ? auction.promise : fixed.promise; },
        onResult: (_leg, result) => results.push(result), onFailure: leg => failures.push(leg.id), isOpportunity: () => false });
    assert.deepEqual(started, ["fixed", "auction"], "a slow BIN check cannot starve auctions");
    fixed.reject(new ApiRequestError("Temporary listing failure", true, 1500, "PROVIDER_TEMPORARY", undefined, "listing"));
    auction.resolve("auction checked");
    assert.deepEqual(await work, { found: false });
    assert.deepEqual(failures, ["fixed"]); assert.deepEqual(results, ["auction checked"]);
});

test("a bound opportunity stops sibling work while retaining the actionable result", async () => {
    const found = deferred<string>();
    const results: string[] = [], cancelled: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
        run: (leg, signal) => leg.id === "auction" ? found.promise : new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => { cancelled.push(leg.id); reject(signal.reason); }, { once: true });
        }), onResult: (_leg, result) => results.push(result), onFailure: () => assert.fail("cancellation is not a failed leg"),
        isOpportunity: value => value === "verified" });
    found.resolve("verified");
    assert.deepEqual(await work, { found: true });
    assert.deepEqual(results, ["verified"]); assert.deepEqual(cancelled, ["fixed"]);
});

test("authority, storage, held charges and search-wide failures stop siblings instead of bypassing the hold", async () => {
    for (const failure of [
        new ApiRequestError("Held charge", true, 1500, "AI_EVIDENCE_HELD"),
        new ApiRequestError("Storage failed", true, 1500, "STORAGE_UNAVAILABLE"),
        new ApiRequestError("Accounting failed", true, 1500, "AI_ACCOUNTING"),
        new ApiRequestError("Shared failure", true, 1500, "PROVIDER_TEMPORARY", undefined, "search"),
        new Error("The returned identity did not match"),
    ]) {
        const first = deferred<string>();
        let cancelled = false;
        const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
            run: (leg, signal) => leg.id === "fixed" ? first.promise : new Promise<string>((_resolve, reject) => {
                signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
            }), onResult: () => assert.fail("no purchase result"), onFailure: () => assert.fail("hard failure cannot skip to another leg"), isOpportunity: () => false });
        first.reject(failure);
        await assert.rejects(work, error => error === failure);
        assert.equal(cancelled, true);
        assert.equal(independentHuntFailure(failure), false);
    }
});

test("Stop aborts every active format without returning an incomplete hunt as complete", async () => {
    const stop = new AbortController(), cancelled: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: stop.signal,
        run: (leg, signal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => {
            cancelled.push(leg.id); reject(signal.reason);
        }, { once: true })), onResult: () => assert.fail("no result"), onFailure: () => assert.fail("Stop is not a provider failure"), isOpportunity: () => false });
    stop.abort();
    await assert.rejects(work, { name: "AbortError" });
    assert.deepEqual(cancelled, ["fixed", "auction"]);
});

test("Both uses different hunt IDs under one original request account", async t => {
    const root = "11111111-2222-4333-8444-555555555555";
    const ids = [newWatchScanId(root), newWatchScanId(root)];
    const calls: { id: string | null; owner: string | null; format: string }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
        const headers = new Headers(options.headers);
        const body = JSON.parse(String(options.body));
        calls.push({ id: headers.get("X-Pokemon-Flipper-Search-Id"), owner: headers.get("X-Pokemon-Flipper-Watch-Budget"), format: body.filters.typeFilter });
        return Response.json({ report: { decision: "WAIT" }, evaluation: null });
    });
    await runGuidedHuntLegs({ legs: legs.map((leg, index) => ({ ...leg, id: ids[index] })), signal: new AbortController().signal,
        run: (leg, signal) => runDealHunt(leg.id, { goal: "resell", standalone: true, scope: "any_card", listingIds: [], targets: { minProfit: 0, minRoi: 0 }, filters: { typeFilter: leg.format } }, signal),
        onResult() {}, onFailure: () => assert.fail("no failure"), isOpportunity: () => false });
    assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id);
    assert.ok(calls.every(call => call.owner === root));
    assert.deepEqual(calls.map(call => call.format), ["FIXED_PRICE", "AUCTION"]);
});

test("provisional hunt cards show original copies and asking prices without a purchase verdict", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    t.after(() => vite.close());
    const { HuntCandidateCards } = await vite.ssrLoadModule("/src/components/DealHunt.tsx");
    const listing: ListingSummary = { id: "v1|120000000001|0", title: "Mewtwo Base Set 10/102 Holo", currentPrice: 45,
        shipping: 5, bids: 0, buyingOption: "FIXED_PRICE", endTime: null, isGraded: false, seller: null,
        url: "https://www.ebay.com/itm/120000000001", images: ["/fixture-front.png"] };
    const render = (active: boolean) => renderToStaticMarkup(createElement(HuntCandidateCards, { listings: [listing], now: Date.now(), active, shortlistButton: () => null }));
    const active = render(true);
    assert.match(active, /Candidates being checked/); assert.match(active, /Mewtwo Base Set/);
    assert.match(active, /Asking price.*45\.00/); assert.match(active, /fixture-front\.png/);
    assert.match(active, /purchase decision is not ready/); assert.doesNotMatch(active, /data-decision="BUY"|Max item price|verified flip/);
    assert.match(render(false), /do not have a verified purchase recommendation/);
});
