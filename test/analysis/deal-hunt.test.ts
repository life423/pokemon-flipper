import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { type DealHuntAction } from "../../shared/deal-hunt.ts";
import { AiSearchAllowanceError, aiSpending } from "../../server/ai/spending.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { aiUsageToday } from "../../server/ai/usage.ts";
import { type DealHuntCandidate, runDealHunt } from "../../server/analysis/deal-hunt.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";

const searchId = "addc12de-bbbe-4f5a-bae0-9a369a92ced2";
type Prompt = { inventory: { index: number; title: string; listingId: string; freshRawGradingLead?: boolean }[];
    observed: { listingId: string | null; action: DealHuntAction | "find_listings"; observation: string; hypothesisTested?: string }[];
    menu: { key: string }[]; tools?: Record<string, string>; remainingChecks: number };
function planner(select: (prompt: Prompt) => string | { choice: string; reason: string }) {
    const cache = new Map();
    let dispatches = 0;
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            dispatches++;
            assert.deepEqual(request.photos, []);
            assert.equal(getAiUsageContext().searchId, searchId);
            const choice = select(JSON.parse(request.prompt));
            return { result: typeof choice === "string" ? { choice, reason: "Inspect the evidence that matters for this copy." } : choice,
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

test("a fresh raw lead can redirect the planner to a condition-matched raw exit or a different copy to grade", async () => {
    for (const goal of ["grade_raw", "resell"] as const) {
        function candidate(listingId: string, fresh: boolean): DealHuntCandidate {
            return {
                listingId, title: listingId, summary: fresh ? "Listed raw as Near Mint. Front and back available." : "Raw copy with front and back.",
                freshRawGradingLead: fresh,
                available(checked) {
                    const actions: DealHuntAction[] = ["inspect_photos", "check_listing", "check_sales"];
                    if (checked.has("inspect_photos") && checked.has("check_sales")) actions.push("calculate_grading");
                    if (goal === "resell" && checked.has("inspect_photos")) actions.push("check_raw_resale");
                    return actions;
                },
                read(action) {
                    if (action === "inspect_photos") return fresh ? "Corner crease visible." : "Clean front and back, estimated grade 8.";
                    if (action === "check_raw_resale") return "Five condition-matched sales support the raw exit.";
                    if (action === "calculate_grading") return "Profitable at both 8 and 7 after submission costs.";
                    return action === "check_sales" ? "Recent matched sales at grades 8 and 7." : "Verified delivered cost.";
                },
                outcome(checked) {
                    if (!checked.has("check_listing") || !checked.has("inspect_photos")) return null;
                    if (fresh && checked.has("check_raw_resale")) return { decision: "BUY", section: "sales", reason: "The raw exit clears costs." };
                    if (!fresh && checked.has("calculate_grading")) return { decision: "BUY", section: "grading", reason: "The lower grade clears costs." };
                    return null;
                },
            };
        }
        const markets = [candidate("Fresh copy", true), candidate("Second copy", false)].map(copy => ({
            title: copy.title, summary: "Recent sales at multiple grades.", discover: async () => [copy],
        }));
        const inspectReason = "The fresh seller-described Near Mint copy may have enough margin to grade. Check its corners.";
        const model = planner(({ inventory, observed, menu }) => {
            const keys = menu.map(row => row.key);
            if (!inventory.length) return "market-0/find_listings";
            assert.equal(inventory[0].freshRawGradingLead, true);
            const inspection = observed.find(step => step.listingId === "Fresh copy" && step.action === "inspect_photos");
            if (!inspection) return { choice: "0/inspect_photos", reason: inspectReason };
            assert.equal(inspection.hypothesisTested, inspectReason);
            assert.equal(inspection.observation, "Corner crease visible.");
            if (goal === "grade_raw" && inventory.length === 1) {
                assert.ok(keys.includes("market-1/find_listings"), "The crease lets the AI switch markets before pricing the damaged copy.");
                assert.ok(!keys.includes("0/check_raw_resale"));
                return { choice: "market-1/find_listings", reason: "A crease cuts grading upside. Search another liquid market." };
            }
            const route = goal === "resell"
                ? ["0/check_raw_resale", "0/check_listing", "0/finish/sales"]
                : ["1/inspect_photos", "1/check_sales", "1/calculate_grading", "1/check_listing", "1/finish/grading"];
            return route.find(choice => keys.includes(choice))!;
        });
        const run = () => runDealHunt({ searchId, goal, candidates: [], markets }, undefined, model.choose);
        const report = await run();
        assert.equal(report.decision, "BUY", report.reason);
        assert.deepEqual(report.destination, goal === "resell" ? { listingId: "Fresh copy", section: "sales" } : { listingId: "Second copy", section: "grading" });
        assert.ok(report.steps.every(step => !(step.listingId === "Fresh copy" && step.action === "calculate_grading")));
        const dispatches = model.dispatches();
        const replay = await run();
        assert.deepEqual(replay.destination, report.destination);
        assert.equal(model.dispatches(), dispatches);
    }
});

test("standalone raw grading can switch markets after two misses and reserves checks to verify a purchased copy", async () => {
    const visits: number[] = [];
    const markets = Array.from({ length: 6 }, (_, index) => ({
        title: `Raw market ${index}`, summary: "Matched grade sales.",
        discover: async () => { visits.push(index); return []; },
    }));
    const model = planner(({ menu }) => menu.at(-1)!.key);
    const report = await runDealHunt({ searchId, goal: "grade_raw", candidates: [], markets, maxSteps: 8 }, undefined, model.choose);
    assert.deepEqual(visits, [5, 4, 3, 2]);
    assert.equal(report.decision, "WAIT");
    assert.match(report.reason, /4 markets checked.*verify a copy/);
});

test("after three markets and two Mewtwo photo checks, the grading hunt prices a feasible copy before the eight-check limit", async () => {
    for (const lowerProfit of [-6, 14]) {
        const copies: DealHuntCandidate[] = ["A", "B", "C"].map((letter, index) => ({
            listingId: letter, title: `Mewtwo ${letter}`, summary: `Fresh raw copy, asking $${[37, 28, 52][index]}.`,
            freshRawGradingLead: true,
            available(checked) {
                if (!checked.has("inspect_photos")) return ["inspect_photos"];
                return checked.has("check_sales") ? ["check_listing", "calculate_grading"] : ["check_listing", "check_sales"];
            },
            read(action) {
                if (action === "inspect_photos") return `Visible edge wear. Estimated grade ${index === 2 ? 3 : 4}.`;
                if (action === "check_listing") return "Shipping and tax checked.";
                if (action === "check_sales") return "Matched sales at grades 4 and 3.";
                return `Likely grade 4 projects $22, grade 3 projects $${lowerProfit} after costs.`;
            },
            outcome(checked) {
                return checked.has("check_listing") && checked.has("calculate_grading")
                    ? { decision: lowerProfit > 0 ? "BUY" : "WAIT", section: "grading", reason: `At grade 3 the profit is $${lowerProfit}.` } : null;
            },
        }));
        const markets = ["First empty market", "Second empty market", "Mewtwo"].map((title, index) => ({
            title, summary: "Recent grade-matched sales.", discover: async () => index === 2 ? copies : [],
        }));
        // Replay the live planner's preference for a third copy's photos/terms, whenever the host would allow it.
        const priority = ["market-0/find_listings", "market-1/find_listings", "market-2/find_listings", "0/inspect_photos",
            "1/inspect_photos", "1/check_listing", "2/inspect_photos", "2/check_listing", "1/check_sales", "1/calculate_grading", "1/finish/grading"];
        const model = planner(({ menu }) => priority.find(key => menu.some(item => item.key === key))!);
        const report = await runDealHunt({ searchId, goal: "grade_raw", candidates: [], markets, maxSteps: 8 }, undefined, model.choose);
        assert.deepEqual(report.steps.map(step => [step.listingId, step.action]), [
            [null, "find_listings"], [null, "find_listings"], [null, "find_listings"], ["A", "inspect_photos"],
            ["B", "inspect_photos"], ["B", "check_listing"], ["B", "check_sales"], ["B", "calculate_grading"],
        ]);
        assert.equal(report.decision, lowerProfit > 0 ? "BUY" : "WAIT");
        assert.deepEqual(report.destination, { listingId: "B", section: "grading" });
        assert.match(report.reason, /At grade 3/);
    }
});

test("a late printing requirement that exceeds the grading allowance leaves a Wait with the concrete photo finding", async () => {
    const copy: DealHuntCandidate = {
        listingId: "unclear", title: "Mewtwo holo", summary: "Raw holo.",
        available(checked) {
            if (!checked.has("inspect_photos")) return ["inspect_photos"];
            if (!checked.has("check_listing")) return ["check_listing"];
            return ["resolve_printing", "check_sales"];
        },
        read(action) {
            if (action === "inspect_photos") return "Visible back whitening. Estimated grade 4.";
            if (action === "check_listing") return "The seller changed the claimed printing.";
            assert.fail("Insufficient steps to check the printing, sales and grading economics.");
        },
        outcome: () => null,
    };
    const markets = [0, 1, 2, 3].map(index => ({
        title: `Market ${index}`, summary: "Recent grade sales.", discover: async () => index === 3 ? [copy] : [],
    }));
    const report = await runDealHunt({ searchId, goal: "grade_raw", candidates: [], markets, maxSteps: 8 }, undefined, planner(({ menu }) => menu[0].key).choose);
    assert.equal(report.decision, "WAIT");
    assert.equal(report.destination, null);
    assert.equal(report.steps.length, 6);
    assert.match(report.reason, /Mewtwo holo.*Visible back whitening\. Estimated grade 4/);
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
    assert.equal(result.reason, "limit reached");
    await assert.rejects(runDealHunt(input, AbortSignal.abort(), model.choose), { name: "AbortError" });
    assert.equal(model.dispatches(), 1);
});

test("the hunt cannot repeat a tool or continue searching beyond the bounded research steps", async () => {
    const candidates: DealHuntCandidate[] = Array.from({ length: 10 }, (_, index) => ({
        listingId: String(index), title: `Copy ${index}`, summary: "Saved slab",
        available: () => ["check_sales"], read: () => "Exact sales missing", outcome: () => null,
    }));
    const model = planner(({ menu }) => menu[0].key);
    const result = await runDealHunt({ searchId, goal: "collect_slab", candidates, maxSteps: 8 }, undefined, model.choose);
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

test("an output-limited planning response after broad discovery uses one permissible evidence check and replays without repurchasing the response", async t => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-capped-hunt";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    t.mock.method(aiSpending, "reserve", async () => null);
    const root = "6ed21122-5b63-4630-abad-3b90a4d3ef7a";
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        assert.equal(url.origin + url.pathname, "https://api.openai.com/v1/responses");
        assert.equal(getAiUsageContext().searchId, root);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_output_tokens, 160);
        const { inventory, menu, observed } = JSON.parse(body.input[0].content[0].text) as Prompt;
        const at = requests++;
        const allowed = menu.map(entry => entry.key);
        const response = { id: `offline-capped-${at}`, object: "response", model: body.model, service_tier: "default" };
        const message = (text: string) => [{ type: "message", role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }] }];
        if (at === 3) {
            assert.equal(inventory.length, 50);
            assert.deepEqual(observed.map(step => step.action), ["find_listings", "find_listings", "find_listings"]);
            assert.equal(allowed.length, 50);
            assert.ok(allowed.every(choice => choice.endsWith("/inspect_photos")));
            return Response.json({ ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
                output: message('{"choice":"market-0/find_listings","reason":"This partial answer is never used'),
                usage: { input_tokens: 6196, output_tokens: 160 } });
        }
        const choice = ["market-0/find_listings", "market-2/find_listings", "market-4/find_listings",
            null, "0/check_listing", "0/check_sales"][at];
        assert.ok(choice && allowed.includes(choice), JSON.stringify({ choice, allowed }));
        return Response.json({ ...response, status: "completed", output: message(JSON.stringify({ choice, reason: "Check the next valid option." })),
            usage: { input_tokens: 100, output_tokens: 31 } });
    });

    const checked: string[] = [], marketsVisited: number[] = [];
    const candidates: DealHuntCandidate[] = Array.from({ length: 50 }, (_, index) => ({
        listingId: `copy-${index}`, title: `Broad inventory copy ${index}`, summary: "Screened copy from the requested release.",
        available: done => done.has("check_listing") ? ["check_sales"] : done.has("inspect_photos") ? ["check_listing"] : ["inspect_photos"],
        read(action) {
            assert.equal(getAiUsageContext().listingId, `copy-${index}`);
            checked.push(`${index}/${action}`);
            return `Evidence checked for ${action}.`;
        },
        outcome: done => done.has("inspect_photos") && done.has("check_listing") && done.has("check_sales")
            ? { decision: "BUY", section: "sales", reason: "The fixture purchase has matching prices, verified photos and current terms." } : null,
    }));
    const markets = Array.from({ length: 5 }, (_, index) => ({
        title: `Market ${index}`, summary: "A permitted market under the original account.",
        ...(index === 4 && { source: "inventory" as const }),
        async discover() {
            assert.equal(getAiUsageContext().searchId, root);
            marketsVisited.push(index);
            return index === 4 ? candidates : [];
        },
    }));
    const cache = new Map<string, any>();
    const makeRunner = () => createModelExperimentRunner({ cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); } });
    const input = { searchId: root, goal: "resell" as const, candidates: [], markets, preferRecentSales: true };
    const first = await runDealHunt(input, undefined, makeRunner());
    assert.deepEqual(marketsVisited, [0, 2, 4]);
    assert.deepEqual(checked, ["0/inspect_photos", "0/check_listing", "0/check_sales"]);
    assert.deepEqual(first.destination, { listingId: "copy-0", section: "sales" });
    assert.equal(first.steps[3].selectedBy, "app");
    assert.equal(first.steps[3].reused, false);
    const retained = [...cache.values()].find(value => value.outputLimit === true);
    assert.equal(retained?.result, null, "partial text cannot be a valid decision");
    assert.deepEqual(retained?.usage, { inputTokens: 6196, outputTokens: 160 });

    const replay = await runDealHunt(input, undefined, makeRunner());
    assert.deepEqual(replay.destination, first.destination);
    assert.equal(replay.steps[3].selectedBy, "app");
    assert.equal(replay.steps[3].reused, true);
    assert.equal(requests, 6, "the accepted capped response and every prior choice cost one request even across runner restart");
    assert.equal((await aiUsageToday(root)).stages.find(stage => stage.step === "Choose deal research")?.failed, 1);
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

test("guided fresh resale uses the failed copy to choose the next copy and finishes its checks", async () => {
    const seen: string[] = [], guidance: string[] = [];
    const make = (listingId: string): DealHuntCandidate => ({
        listingId, title: listingId, summary: "Fresh fixed-price copy",
        available: checked => checked.has("inspect_photos") ? ["check_sales"] : ["inspect_photos"],
        read(action) { seen.push(listingId + " " + action); return listingId === "first" ? "Front is too blurry." : "Matching front and number."; },
        outcome: checked => checked.has(listingId === "first" ? "inspect_photos" : "check_sales") ?
            { decision: listingId === "third" ? "BUY" : "WAIT", section: "sales", reason: "Checked photos and matched prices." } : null,
    });
    const model = planner(prompt => {
        assert.ok(prompt.observed.some(step => step.observation.includes("too blurry")));
        return { choice: "2/inspect_photos", reason: "Check the third copy because its front is readable." };
    });
    const report = await runDealHunt({ searchId, goal: "resell", candidates: [], freshListings: true, guidedResale: true,
        progress: { stage() {}, checked() {}, guidance: reason => guidance.push(reason) },
        markets: [{ title:"Ampharos", summary:"Current copies", discover: async () => ["first","second","third"].map(make) }] }, undefined, model.choose);
    assert.deepEqual(seen, ["first inspect_photos", "third inspect_photos", "third check_sales"]);
    assert.equal(model.dispatches(), 1);
    assert.match(guidance[0], /third copy/);
    assert.equal(report.destination?.listingId, "third");
    assert.equal(report.decision, "BUY");
});

test("resale continues past fifty copies and 128 checks until a supported purchase is found", async () => {
    let discovered = 0;
    const checked: string[] = [];
    const report = await runDealHunt({ searchId, goal: "resell", candidates: [], freshListings: true,
        markets: [{ title: "Continuing live inventory", summary: "More distinct physical copies remain.",
            hasMore: () => discovered < 80,
            discover: async () => {
                const number = ++discovered;
                return [{ listingId: `copy-${number}`, title: `Copy ${number}`, summary: "Same market, independent condition.",
                    available: () => ["inspect_photos"],
                    read: () => { checked.push(`copy-${number}`); return "Observed the actual copy."; },
                    outcome: completed => completed.has("inspect_photos") ? {
                        decision: number === 75 ? "BUY" : "WAIT", section: "photos", reason: number === 75
                            ? "This copy has a verified profitable route." : "This copy does not meet the target.",
                    } : null }];
            } }],
    }, undefined, planner(() => assert.fail("The next bounded inventory check is already determined.")).choose);
    assert.equal(report.decision, "BUY");
    assert.equal(report.destination?.listingId, "copy-75");
    assert.equal(discovered, 75, "stop discovery as soon as a supported flip is found");
    assert.equal(checked.length, 75);
    assert.equal(new Set(checked).size, 75);
    assert.ok(report.steps.length > 128, "the old total research-step ceiling cannot end a resale hunt");
});

test("a continuing resale hunt still stops immediately on buyer cancellation", async () => {
    const stop = new AbortController();
    let discovered = 0;
    await assert.rejects(runDealHunt({ searchId, goal: "resell", candidates: [], freshListings: true,
        markets: [{ title: "Live inventory", summary: "Source has more copies.", hasMore: () => true,
            discover: async () => {
                const number = ++discovered;
                return [{ listingId: `copy-${number}`, title: `Copy ${number}`, summary: "Needs review.",
                    available: () => ["inspect_photos"],
                    read: () => { if (number === 3) stop.abort(); return "No profitable route."; },
                    outcome: completed => completed.has("inspect_photos") ? { decision: "WAIT", section: "photos", reason: "Not a flip." } : null }];
            } }],
    }, stop.signal, planner(() => assert.fail("No planning request is needed.")).choose), { name: "AbortError" });
    assert.equal(discovered, 3);
});

test("an explicit otherwise-supported stale-terms check can refresh once without repeating photos", async () => {
    const reads: string[] = [];
    let termsFresh = true;
    const candidate: DealHuntCandidate = {
        listingId: "stale-copy", title: "Promising copy", summary: "Saved photos and supported resale.",
        available: completed => ["check_listing", "inspect_photos", "check_sales"].filter(action =>
            !completed.has(action as DealHuntAction) || action === "check_listing" && !termsFresh) as DealHuntAction[],
        canRepeat: action => action === "check_listing" && !termsFresh,
        read(action) {
            reads.push(action);
            if (action === "check_listing") termsFresh = true;
            if (action === "check_sales") termsFresh = false; // Long research expired the earlier quote.
            return "Accepted evidence retained.";
        },
        outcome: completed => ["check_listing", "inspect_photos", "check_sales"].every(action => completed.has(action as DealHuntAction))
            ? { decision: termsFresh ? "BUY" : "WAIT", section: "sales", reason: termsFresh ? "Fresh terms support the purchase." : "Terms need refreshing." } : null,
    };
    const report = await runDealHunt({ searchId, goal: "resell", candidates: [candidate], freshListings: true },
        undefined, planner(() => assert.fail("The next verification is determined.")).choose);
    assert.equal(report.decision, "BUY");
    assert.deepEqual(reads, ["check_listing", "inspect_photos", "check_sales", "check_listing"]);
});

test("a terms refresh that still cannot support buying cannot become an endless retry loop", async () => {
    let reads = 0;
    const report = await runDealHunt({ searchId, goal: "resell", freshListings: true, candidates: [{
        listingId: "unrefreshable", title: "Terms still unavailable", summary: "Saved evidence cannot settle current shipping.",
        available: () => ["check_listing"], canRepeat: () => true,
        read: () => { reads++; return "Fresh purchase terms could not be established."; },
        outcome: checked => checked.has("check_listing") ? { decision: "WAIT", section: "listing", reason: "Current terms remain unavailable." } : null,
    }] }, undefined, planner(() => assert.fail("No model call is needed.")).choose);
    assert.equal(report.decision, "WAIT");
    assert.equal(reads, 2, "one original terms check and one explicitly eligible refresh");
});

test("closed Waits cannot hide a later initial copy from the bounded planning menu", async () => {
    let reads = 0;
    const candidates: DealHuntCandidate[] = Array.from({ length: 40 }, (_, index) => ({
        listingId: `retained-${index}`, title: `Retained copy ${index}`, summary: "An independent physical copy.",
        available: () => ["inspect_photos"], read: () => { reads++; return "Copy-specific condition checked."; },
        outcome: completed => completed.has("inspect_photos") ? {
            decision: index === 27 ? "BUY" : "WAIT", section: "photos", reason: index === 27 ? "Supported flip." : "Not a flip.",
        } : null,
    }));
    const model = planner(({ menu }) => menu.find(option => option.key.endsWith("/inspect_photos"))?.key ?? menu[0].key);
    const report = await runDealHunt({ searchId, goal: "resell", candidates }, undefined, model.choose);
    assert.equal(report.decision, "BUY");
    assert.equal(report.destination?.listingId, "retained-27");
    assert.equal(reads, 28);
});

test("Find a flip dispatches the model's chosen resale route after the same listing prerequisites", async () => {
    for (const route of ["check_raw_resale", "calculate_grading"] as const) {
        const reads: DealHuntAction[] = [];
        const copy: DealHuntCandidate = {
            listingId: "raw-copy", title: "Ampharos", summary: "Raw copy with graded and condition-matched sales",
            available: checked => checked.has("check_sales") ? ["check_raw_resale", "calculate_grading"] :
                ["check_listing", "inspect_photos", "check_sales"],
            read(action) { reads.push(action); return "Evidence recorded for " + action; },
            outcome: checked => checked.has(route) ? { decision: "BUY", section: route === "calculate_grading" ? "grading" : "sales",
                reason: "The checked route meets the resale target." } : null,
        };
        const model = planner(({ menu, tools, observed }) => {
            assert.deepEqual(Object.keys(tools ?? {}).sort(), ["calculate_grading", "check_raw_resale"]);
            assert.match(tools!.calculate_grading, /one grade lower/);
            assert.match(tools!.check_raw_resale, /assessed condition/);
            assert.ok(observed.some(step => step.action === "inspect_photos"));
            assert.deepEqual(menu.map(option => option.key).sort(), ["0/calculate_grading", "0/check_raw_resale"]);
            return "0/" + route;
        });
        const result = await runDealHunt({ searchId, goal: "resell", freshListings: true, guidedResale: true,
            candidates: [copy] }, undefined, model.choose);
        assert.equal(model.dispatches(), 1);
        assert.deepEqual(reads, ["check_listing", "inspect_photos", "check_sales", route]);
        assert.equal(result.steps.at(-1)?.selectedBy, "model");
        assert.equal(result.decision, "BUY");
    }
});

test("Find a flip keeps researching an eligible auction when another copy already has a Wait", async () => {
    const model = planner(({ menu }) => menu.find(row => row.key.includes("/finish/"))?.key ?? menu[0].key);
    const candidates: DealHuntCandidate[] = ["first", "second"].map((listingId, index) => ({
        listingId, title: listingId, summary: "Auction within ten hours", available: () => ["check_listing"],
        read: () => "Next bid and costs verified.",
        outcome: checked => checked.size ? { decision: index ? "BID" : "WAIT", section: "sales", reason: "Checked bid and resale." } : null,
    }));
    const result = await runDealHunt({ searchId, goal: "resell", guidedResale: true, auction: true, candidates }, undefined, model.choose);
    assert.equal(result.decision, "BID");
    assert.equal(result.destination?.listingId, "second");
});

for (const explore of [true, false]) test(`flexible resale can ${explore ? "switch after the first loss and return to saved copies" : "stay for a promising third copy"}`, async () => {
    const inspected: string[] = [];
    const market = (listingId: string): DealHuntCandidate => ({
        listingId, title: listingId, summary: "Eligible copy",
        available: () => ["inspect_photos"],
        read() { inspected.push(listingId); return "Compared the exact copy to recent sold prices."; },
        outcome: checked => !checked.has("inspect_photos") ? null : { decision: listingId === "third A" ? "BUY" : "WAIT",
            section: "sales", reason: listingId === "third A" ? "Profitable after costs." : "Delivered cost exceeds the exit." },
    });
    let page = 0;
    const decisions: string[] = [];
    const chooser = planner(({ menu, observed }) => {
        const market = menu.find(option => option.key.endsWith("/find_listings"));
        const copy = menu.find(option => option.key.endsWith("/inspect_photos"))!;
        if (market && copy) {
            decisions.push(observed.at(-1)!.listingId!);
            if (explore) return market.key;
        }
        return copy.key;
    });
    const report = await runDealHunt({ searchId, goal: "resell", freshListings: true, guidedResale: true, rotateMarkets: true,
        candidates: [], markets: [{ source: "inventory", title: "Eligible markets", summary: "Current copies.",
            hasMore: () => page < 2,
            discover: async () => (page++ === 0 ? ["first A", "second A", "third A"] : ["first B"]).map(market) }] }, undefined, chooser.choose);
    assert.equal(report.decision, "BUY");
    assert.deepEqual(decisions, explore ? ["first A"] : ["first A", "second A"]);
    assert.deepEqual(inspected, explore ? ["first A", "first B", "second A", "third A"] : ["first A", "second A", "third A"]);
    assert.equal(page, explore ? 2 : 1);
});

test("resale scheduling grows linearly across a 100-copy and a 1,600-copy losing page", async t => {
    const counts = [];
    for (const size of [100, 1600]) {
        let eligible = 0, reviewed = 0;
        const copies: DealHuntCandidate[] = Array.from({ length: size }, (_, index) => ({
            listingId: String(index), title: "Copy " + index, summary: "Raw single",
            available() { eligible++; return ["inspect_photos"]; },
            read() { reviewed++; return "The pictured printing does not match."; },
            outcome(done) { return done.has("inspect_photos") ? { decision: "WAIT", section: "photos", reason: "Different printing." } : null; },
        }));
        const result = await runDealHunt({ searchId, goal: "resell", candidates: [], freshListings: true,
            markets: [{ title: "Local page", summary: "", discover: async () => copies }] });
        assert.equal(result.decision, "WAIT");
        assert.equal(reviewed, size);
        counts.push(eligible);
    }
    assert.ok(counts[1] <= 20 * counts[0]);
    t.diagnostic("Eligibility checks for 100 and 1,600 copies: " + counts.join(", "));
});

test("optional price lookups in a full window leave room for an unreviewed primary photo", async () => {
    const copies: DealHuntCandidate[] = Array.from({ length: 60 }, (_, index) => ({
        listingId: String(index), title: "Copy " + index, summary: "Offline listing",
        available: () => index === 59 ? ["inspect_photos"] : ["search_web_sales", "move_on"],
        read(action) { assert.equal(action, "inspect_photos"); return "Current matching evidence."; },
        outcome: done => done.has("inspect_photos") ? { decision: "BUY", section: "sales", reason: "Verified winning fixture." } : null,
    }));
    const result = await runDealHunt({ searchId, goal: "resell", candidates: [], freshListings: true, guidedResale: true,
        markets: [{ title: "Local page", summary: "", discover: async () => copies }] });
    assert.equal(result.destination?.listingId, "59");
});
