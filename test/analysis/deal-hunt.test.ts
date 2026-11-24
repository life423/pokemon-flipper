import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { type DealHuntAction } from "../../shared/deal-hunt.ts";
import { AiSearchAllowanceError, aiSpending } from "../../server/ai/spending.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { type DealHuntCandidate, runDealHunt } from "../../server/analysis/deal-hunt.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";

const searchId = "addc12de-bbbe-4f5a-bae0-9a369a92ced2";
type Prompt = { inventory: { index: number; title: string; listingId: string }[];
    observed: { listingId: string; action: DealHuntAction; observation: string }[];
    menu: { key: string }[]; remainingChecks: number };
function planner(select: (prompt: Prompt) => string) {
    const cache = new Map();
    let dispatches = 0;
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            dispatches++;
            assert.deepEqual(request.photos, []);
            assert.equal(getAiUsageContext().searchId, searchId);
            return { result: { choice: select(JSON.parse(request.prompt)), reason: "Inspect the evidence that matters for this copy." },
                usage: { inputTokens: 30, outputTokens: 10 } };
        },
    });
    return { choose, dispatches: () => dispatches };
}

test("a changed observation redirects the hunt to a different listing and section, and identical planning decisions are reused", async () => {
    let photo = "Surface worn";
    const reads: string[] = [];
    function candidate(index: number, title: string): DealHuntCandidate {
        const id = String(index);
        return { listingId: id, title, summary: "Raw single",
            available: () => ["inspect_photos", "check_sales", "calculate_grading"],
            read(action) {
                assert.equal(getAiUsageContext().listingId, id);
                reads.push(`${id}/${action}`);
                if (action === "inspect_photos") return index === 0 ? photo : "Clean enough for grading";
                if (action === "calculate_grading") return "The lower grade clears costs";
                return "Same-printing sales on file";
            },
            outcome(checked) {
                if (index === 0 && photo === "Surface worn" && checked.has("inspect_photos")) {
                    return { decision: "WAIT", section: "photos", reason: "Visible surface wear reduces grading potential." };
                }
                return ["inspect_photos", "check_sales", "calculate_grading"].every(action => checked.has(action as DealHuntAction))
                    ? { decision: "BUY", section: "grading", alternateSections: ["sales"], reason: "The lower grade clears costs." } : null;
            } };
    }
    const input = { searchId, goal: "grade_raw" as const, candidates: [candidate(0, "Alakazam"), candidate(1, "Poliwrath")] };
    const model = planner(({ observed, menu }) => {
        if (observed.length === 0) return "0/inspect_photos";
        const index = observed.some(step => step.observation === "Surface worn") ? 1 : 0;
        return ["inspect_photos", "check_sales", "calculate_grading", "finish/grading"]
            .map(action => `${index}/${action}`).find(key => menu.some(entry => entry.key === key))!;
    });
    const first = await runDealHunt(input, undefined, model.choose);
    assert.deepEqual(reads, ["0/inspect_photos", "1/inspect_photos", "1/check_sales", "1/calculate_grading"]);
    assert.deepEqual(first.destination, { listingId: "1", section: "grading" });
    assert.equal(first.decision, "BUY");
    const dispatches = model.dispatches();
    reads.length = 0;
    const replay = await runDealHunt(input, undefined, model.choose);
    assert.equal(model.dispatches(), dispatches);
    assert.ok(replay.steps.every(step => step.reused === true));
    photo = "Clean enough for grading";
    const changed = await runDealHunt(input, undefined, model.choose);
    assert.deepEqual(changed.destination, { listingId: "0", section: "grading" });
    assert.equal(changed.steps[0].reused, true);
    assert.ok(model.dispatches() > dispatches);
});

test("invented cross-listing destinations cannot dispatch, and a cached invalid choice is not purchased again", async () => {
    const model = planner(() => "ads/finish/grading");
    const candidate: DealHuntCandidate = { listingId: "CGC", title: "Dark Gengar", summary: "CGC 8.5",
        available: () => ["check_sales", "check_listing"], read: () => assert.fail("invalid tool dispatched"), outcome: () => null };
    const input = { searchId, goal: "collect_slab" as const, candidates: [candidate] };
    await assert.rejects(runDealHunt(input, undefined, model.choose), /invalid/i);
    await assert.rejects(runDealHunt(input, undefined, model.choose), /invalid/i);
    assert.equal(model.dispatches(), 1);
});

test("AI spending limits and cancellation preserve the caller's search boundary", async () => {
    const candidate: DealHuntCandidate = { listingId: "CGC", title: "Dark Gengar", summary: "Slab",
        available: () => ["check_sales", "check_listing"], read: () => assert.fail("dispatched after budget or cancellation"), outcome: () => null };
    const input = { searchId, goal: "collect_slab" as const, candidates: [candidate] };
    const model = planner(() => { throw new AiSearchAllowanceError("limit reached"); });
    const result = await runDealHunt(input, undefined, model.choose);
    assert.equal(result.decision, "WAIT");
    assert.equal(result.destination, null);
    assert.match(result.reason, /allowance/);
    await assert.rejects(runDealHunt(input, AbortSignal.abort(), model.choose), { name: "AbortError" });
    assert.equal(model.dispatches(), 1);
});

test("the hunt cannot repeat a tool or continue searching beyond the bounded research steps", async () => {
    const candidates: DealHuntCandidate[] = Array.from({ length: 10 }, (_, index) => ({
        listingId: String(index), title: `Copy ${index}`, summary: "Saved slab",
        available: () => ["check_sales"], read: () => "Exact sales missing", outcome: () => null,
    }));
    const model = planner(({ menu }) => menu[0].key);
    const result = await runDealHunt({ searchId, goal: "collect_slab", candidates }, undefined, model.choose);
    assert.equal(result.decision, "WAIT");
    assert.match(result.reason, /research limit/);
    assert.equal(result.steps.length, 8);
    assert.equal(new Set(result.steps.map(step => step.listingId)).size, 8);
});

test("a full retained search can stop on a specific checked wait when the alternatives have no promising lead", async () => {
    const candidates: DealHuntCandidate[] = Array.from({ length: 50 }, (_, index) => ({
        listingId: String(index), title: `Copy ${index}`, summary: "Low-grade copy",
        available: () => ["check_listing", "inspect_photos", "check_sales", "calculate_grading"],
        read: () => "Visible front crease",
        outcome: checked => checked.has("inspect_photos") ? { decision: "WAIT", reason: "Visible front crease.", section: "photos" } : null,
    }));
    const model = planner(({ observed, menu }) => {
        if (!observed.length) {
            assert.equal(menu.length, 200);
            return "0/inspect_photos";
        }
        return "0/finish/photos";
    });
    const result = await runDealHunt({ searchId, goal: "grade_raw", candidates }, undefined, model.choose);
    assert.equal(result.reason, "Visible front crease.");
    assert.deepEqual(result.destination, { listingId: "0", section: "photos" });
    assert.equal(result.steps.length, 1);
});

test("purchase terms that expire during a model decision cannot produce a stale buy", async () => {
    let fresh = true;
    const candidate: DealHuntCandidate = {
        listingId: "CGC", title: "Dark Gengar", summary: "CGC 8.5",
        available: () => ["check_listing"],
        read: () => "Price and destination quote checked",
        outcome: checked => checked.has("check_listing") && fresh ? {
            decision: "BUY", reason: "Checked terms meet the buying goal.", section: "sales", alternateSections: ["photos"],
        } : null,
    };
    const model = planner(() => {
        fresh = false;
        return "0/finish/sales";
    });
    const result = await runDealHunt({ searchId, goal: "collect_slab", candidates: [candidate] }, undefined, model.choose);
    assert.deepEqual(result.steps.map(step => step.action), ["check_listing"]);
    assert.equal(result.decision, "WAIT");
    assert.equal(result.destination, null);
    assert.match(result.reason, /expired/);
});

test("malformed paid output selects a host check, preserves its usage and replays without another generation", async t => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-hunt";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    t.mock.method(aiSpending, "reserve", async () => null);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
        assert.equal(new URL(input instanceof Request ? input.url : input.toString()).pathname, "/v1/responses");
        const body = JSON.parse(String(init?.body));
        calls++;
        return Response.json({ id: "offline-bad-menu", object: "response", status: "completed", model: body.model,
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
                text: '{"choice":"0/inspect_photos","reason":"First"} junk {"choice":"0/check_sales","reason":"Last"}', annotations: [] }] }],
            usage: { input_tokens: 47, output_tokens: 23 } });
    });
    const cache = new Map();
    const choose = createModelExperimentRunner({ cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); } });
    const candidate: DealHuntCandidate = { listingId: "CGC", title: "Dark Gengar", summary: "Slab",
        available: checked => checked.has("check_listing") ? [] : ["inspect_photos", "check_sales", "check_listing"],
        read(action) { assert.equal(action, "check_listing"); return "Checked purchase terms exceed the ceiling."; },
        outcome: () => ({ decision: "WAIT", section: "sales", reason: "The verified terms exceed the buyer's ceiling." }),
    };
    const input = { searchId, goal: "collect_slab" as const, candidates: [candidate] };
    const first = await runDealHunt(input, undefined, choose);
    assert.equal(first.decision, "WAIT");
    assert.equal(first.steps[0].action, "check_listing");
    assert.match(first.steps[0].reason, /unreadable choice/);
    assert.equal(first.steps[0].reused, false);
    const record = [...cache.values()][0];
    assert.equal(record.malformedOutput, true);
    assert.equal(record.result, null);
    assert.deepEqual(record.usage, { inputTokens: 47, outputTokens: 23 });
    const replay = await runDealHunt(input, undefined, choose);
    assert.equal(replay.steps[0].reused, true);
    assert.equal(calls, 1);
});

test("an unrelated transport parse exception is never treated as a planner choice", async () => {
    const broken = new SyntaxError("Upstream transport envelope was corrupt");
    const model = planner(() => { throw broken; });
    const candidate: DealHuntCandidate = { listingId: "G", title: "Gengar", summary: "Slab",
        available: () => ["check_listing", "check_sales"], read: () => assert.fail("Unexpected dispatch"), outcome: () => null };
    await assert.rejects(runDealHunt({ searchId, goal: "collect_slab", candidates: [candidate] }, undefined, model.choose), error => error === broken);
});

test("the auction planner can check two different copies together and reuse the decision", async () => {
    const cache = new Map();
    let selections = 0;
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            selections++;
            const { observed, menu } = JSON.parse(request.prompt) as Prompt;
            if (observed.length) {
                assert.deepEqual(observed.map(step => step.listingId), ["Espeon", "Gengar"]);
                return { result: { choice: "1/finish/sales", reason: "Gengar fits the bid limit." }, usage: { inputTokens: 20, outputTokens: 10 } };
            }
            assert.ok(menu.some(row => row.key === "1/check_sales"));
            return { result: { choice: "0/check_listing", also: "1/check_sales", reason: "Check Espeon's shipping and Gengar's matching sales." },
                usage: { inputTokens: 20, outputTokens: 10 } };
        },
    });
    async function run() {
        let started = 0;
        const candidates: DealHuntCandidate[] = ["Espeon", "Gengar"].map((name, index) => ({
            listingId: name, title: name, summary: "Graded auction under ten hours",
            available: checked => checked.size ? [] : ["check_listing", "check_sales"],
            async read() {
                started++;
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(started, 2, "Both independent reads must be dispatched before either returns");
                assert.equal(getAiUsageContext().listingId, name);
                return index ? "Gengar's next bid is under the supported ceiling." : "Espeon's shipping puts it over budget.";
            },
            outcome: checked => checked.size ? { decision: index ? "BID" : "WAIT", section: "sales",
                alternateSections: ["photos"], reason: index ? "Matched sales support this bid." : "Over budget." } : null,
        }));
        return runDealHunt({ searchId, candidates, goal: "collect_slab", auction: true }, undefined, choose);
    }
    const first = await run();
    assert.equal(first.decision, "BID");
    assert.deepEqual(first.destination, { listingId: "Gengar", section: "sales" });
    assert.deepEqual(first.steps.map(step => step.action), ["check_listing", "check_sales"]);
    assert.deepEqual(first.steps.map(step => step.parallelGroup), [1, 1]);
    assert.equal(selections, 2);
    const replay = await run();
    assert.ok(replay.steps.every(step => step.reused && step.selectedBy === "model"));
    assert.equal(selections, 2);
});

test("a secondary auction check on the first listing cannot run ahead of its result", async () => {
    const actions: string[] = [];
    const choose = createModelExperimentRunner({ cached: async () => null, save: async () => {}, run: async () => ({
        result: { choice: "0/check_listing", also: "0/inspect_photos", reason: "Check this auction." },
        usage: { inputTokens: 5, outputTokens: 5 },
    }) });
    const candidates: DealHuntCandidate[] = ["Espeon", "Gengar"].map(name => ({
        listingId: name, title: name, summary: "Auction",
        available: () => ["check_listing", "inspect_photos"], read: action => { actions.push(action); return "Current terms."; },
        outcome: checked => checked.has("check_listing") ? { decision: "BID", section: "sales", reason: "Fresh terms fit the collector budget." } : null,
    }));
    await runDealHunt({ searchId, candidates, goal: "collect_slab", auction: true }, undefined, choose);
    assert.deepEqual(actions, ["check_listing"]);
});

test("a verified auction survives a simultaneous check exhausting its research allowance", async () => {
    const choose = createModelExperimentRunner({ cached: async () => null, save: async () => {}, run: async () => ({
        result: { choice: "0/check_listing", also: "1/check_sales", reason: "Check both copies." },
        usage: { inputTokens: 5, outputTokens: 5 },
    }) });
    const candidates: DealHuntCandidate[] = [
        { listingId: "A", title: "Espeon", summary: "Auction", available: () => ["check_listing"],
            read() { throw new AiSearchAllowanceError("limit reached"); }, outcome: () => null },
        { listingId: "B", title: "Ampharos", summary: "Auction with verified terms", available: () => ["check_sales"],
            read: () => "Saved sales support the bid.", outcome: checked => checked.has("check_sales")
                ? { decision: "BID", section: "sales", reason: "The next bid fits the checked ceiling." } : null },
    ];
    const result = await runDealHunt({ searchId, goal: "collect_slab", auction: true, candidates }, undefined, choose);
    assert.equal(result.decision, "BID");
    assert.equal(result.destination?.listingId, "B");
    assert.deepEqual(result.steps.map(s => s.listingId), ["B"]);
    assert.equal(result.steps[0].parallelGroup, undefined);
});
