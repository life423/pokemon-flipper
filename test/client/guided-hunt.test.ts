import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { ApiRequestError, newWatchScanId, runDealHunt } from "../../client/src/api.ts";
import { independentHuntFailure, runGuidedHuntLegs, type GuidedHuntLeg } from "../../client/src/search/guided-hunt.ts";
import { HUNT_RECHECK_MS, type DealHuntResponse } from "../../shared/deal-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";

const legs: GuidedHuntLeg[] = [{ id: "fixed", format: "FIXED_PRICE", started: 1 }, { id: "auction", format: "AUCTION", started: 1 }];
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

const reply = (decision: "WAIT" | "BUY" | "BID", nextCheckAt?: number): DealHuntResponse => ({
    report: { decision, searchId: "fixed", goal: "resell", destination: null, reason: "Fixture", steps: [] }, evaluation: null, nextCheckAt,
});

test("Both starts independent format checks immediately; an ordinary temporary leg failure does not abandon the other", async () => {
    const fixed = deferred<DealHuntResponse>(), auction = deferred<DealHuntResponse>();
    const started: string[] = [], results: string[] = [], failures: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
        run: leg => { started.push(leg.id); return leg.format === "AUCTION" ? auction.promise : fixed.promise; },
        onResult: (_leg, result) => results.push(result.report.decision), onWaiting: leg => failures.push(leg.id), isOpportunity: result => result.report.decision === "BID" });
    assert.deepEqual(started, ["fixed", "auction"], "a slow BIN check cannot starve auctions");
    fixed.reject(new ApiRequestError("Temporary listing failure", true, 1500, "PROVIDER_TEMPORARY", undefined, "listing"));
    auction.resolve(reply("BID"));
    assert.equal((await work).report.decision, "BID");
    assert.deepEqual(failures, ["fixed"]); assert.deepEqual(results, ["BID"]);
});

test("a bound opportunity stops sibling work while retaining the actionable result", async () => {
    const found = deferred<DealHuntResponse>();
    const results: string[] = [], cancelled: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
        run: (leg, signal) => leg.id === "auction" ? found.promise : new Promise<DealHuntResponse>((_resolve, reject) => {
            signal.addEventListener("abort", () => { cancelled.push(leg.id); reject(signal.reason); }, { once: true });
        }), onResult: (_leg, result) => results.push(result.report.decision), onWaiting: () => assert.fail("cancellation is not a failed leg"),
        isOpportunity: value => value.report.decision === "BID" });
    found.resolve(reply("BID"));
    assert.equal((await work).report.decision, "BID");
    assert.deepEqual(results, ["BID"]); assert.deepEqual(cancelled, ["fixed"]);
});

test("authority, storage, held charges and search-wide failures stop siblings instead of bypassing the hold", async () => {
    for (const failure of [
        new ApiRequestError("Held charge", true, 1500, "AI_EVIDENCE_HELD"),
        new ApiRequestError("Storage failed", true, 1500, "STORAGE_UNAVAILABLE"),
        new ApiRequestError("Accounting failed", true, 1500, "AI_ACCOUNTING"),
        new ApiRequestError("Shared failure", true, 1500, "PROVIDER_TEMPORARY", undefined, "search"),
        new Error("The returned identity did not match"),
    ]) {
        const first = deferred<DealHuntResponse>();
        let cancelled = false;
        const work = runGuidedHuntLegs({ legs, signal: new AbortController().signal,
            run: (leg, signal) => leg.id === "fixed" ? first.promise : new Promise<DealHuntResponse>((_resolve, reject) => {
                signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
            }), onResult: () => assert.fail("no purchase result"), onWaiting: () => assert.fail("hard failure cannot skip to another leg"), isOpportunity: () => false });
        first.reject(failure);
        await assert.rejects(work, error => error === failure);
        assert.equal(cancelled, true);
        assert.equal(independentHuntFailure(failure), false);
    }
});

test("Stop aborts every active format without returning an incomplete hunt as complete", async () => {
    const stop = new AbortController(), cancelled: string[] = [];
    const work = runGuidedHuntLegs({ legs, signal: stop.signal,
        run: (leg, signal) => new Promise<DealHuntResponse>((_resolve, reject) => signal.addEventListener("abort", () => {
            cancelled.push(leg.id); reject(signal.reason);
        }, { once: true })), onResult: () => assert.fail("no result"), onWaiting: () => assert.fail("Stop is not a provider failure"), isOpportunity: () => false });
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
        return Response.json(reply(body.filters.typeFilter === "AUCTION" ? "BID" : "WAIT"));
    });
    await runGuidedHuntLegs({ legs: legs.map((leg, index) => ({ ...leg, id: ids[index] })), signal: new AbortController().signal,
        run: (leg, signal) => runDealHunt(leg.id, { goal: "resell", standalone: true, scope: "any_card", listingIds: [], targets: { minProfit: 0, minRoi: 0 }, filters: { typeFilter: leg.format } }, signal),
        onResult() {}, onWaiting() {}, isOpportunity: result => result.report.decision === "BID" });
    assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id);
    assert.ok(calls.every(call => call.owner === root));
    assert.deepEqual(calls.map(call => call.format), ["FIXED_PRICE", "AUCTION"]);
});

test("a missed pass waits for the scheduled time and checks the same search again until a verified result", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const waiting = deferred<number>(), checked: string[] = [], current = reply("BUY");
    const work = runGuidedHuntLegs({ legs: [legs[0]], signal: new AbortController().signal,
        run: async leg => { checked.push(leg.id); return checked.length === 1 ? reply("WAIT", 1000 + HUNT_RECHECK_MS) : current; },
        onResult() {}, onWaiting: (_leg, at) => waiting.resolve(at), isOpportunity: result => result === current });
    assert.equal(await waiting.promise, 1000 + HUNT_RECHECK_MS);
    t.mock.timers.tick(HUNT_RECHECK_MS - 1);
    assert.deepEqual(checked, ["fixed"]);
    t.mock.timers.tick(1);
    assert.equal(await work, current);
    assert.deepEqual(checked, ["fixed", "fixed"]);
});

test("a disconnected response and a worker still finishing reconnect to the same leg and account with backoff", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const root = crypto.randomUUID(), id = newWatchScanId(root);
    const receipts: { id: string | null; owner: string | null; body: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
        const headers = new Headers(options.headers);
        receipts.push({ id: headers.get("X-Pokemon-Flipper-Search-Id"), owner: headers.get("X-Pokemon-Flipper-Watch-Budget"), body: options.body });
        if (receipts.length === 1) {
            const response = new Response();
            response.json = async () => { throw new TypeError("Connection closed mid-body"); };
            return response;
        }
        if (receipts.length === 2) return Response.json({ code: "FLIP_RUN_ACTIVE", error: "Already running", retryable: true }, { status: 409 });
        return Response.json(reply("BUY"));
    });
    const waits = [deferred<number>(), deferred<number>()];
    let waited = 0;
    const work = runGuidedHuntLegs({ legs: [{ ...legs[0], id }], signal: new AbortController().signal,
        run: (leg, signal) => runDealHunt(leg.id, { goal: "resell", standalone: true, watch: true, scope: "any_card", listingIds: [],
            targets: { minProfit: 0, minRoi: 0 }, filters: { typeFilter: leg.format } }, signal),
        onWaiting(_leg, at, reason) { assert.match(reason, /same search/); waits[waited++].resolve(at - Date.now()); },
        onResult() {}, isOpportunity: result => result.report.decision === "BUY" });
    for (const [i, wait] of waits.entries()) {
        const ms = await wait.promise;
        assert.equal(ms, 2000 * (i + 1)); t.mock.timers.tick(ms);
    }
    assert.equal((await work).report.decision, "BUY");
    assert.equal(receipts.length, 3);
    assert.equal(receipts[0].owner, root);
    assert.equal(receipts[0].id, id);
    assert.deepEqual(receipts, Array(3).fill(receipts[0]));
});

test("Stop during the next-check countdown prevents every later dispatch, including after a stale Buy", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const waiting = deferred<number>(), controller = new AbortController();
    let calls = 0;
    const work = runGuidedHuntLegs({ legs: [legs[0]], signal: controller.signal,
        run: async () => { calls++; return reply("BUY"); },
        onResult() {}, onWaiting: (_leg, at) => waiting.resolve(at), isOpportunity: () => false });
    assert.equal(await waiting.promise, Date.now() + HUNT_RECHECK_MS);
    controller.abort();
    await assert.rejects(work, { name: "AbortError" });
    t.mock.timers.tick(HUNT_RECHECK_MS * 2);
    assert.equal(calls, 1);
});

test("a spending or accounting hold returned as Wait requires attention without scheduling a new pass", async () => {
    const result = reply("WAIT");
    result.report.needsAttention = true;
    result.report.reason = "Spending paused.";
    await assert.rejects(runGuidedHuntLegs({ legs: [legs[0]], signal: new AbortController().signal, run: async () => result,
        onResult() {}, onWaiting: () => assert.fail("cannot schedule spending around a hold"), isOpportunity: () => false }), /Spending paused/);
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
