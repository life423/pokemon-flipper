import assert from "node:assert/strict";
import test from "node:test";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { MalformedStructuredOutputError } from "../../server/ai/openai.ts";
import { dealHuntCandidate } from "../../server/analysis/deal-hunt-evidence.ts";
import { runDealHunt, type DealHuntCandidate, type DealHuntMarket } from "../../server/analysis/deal-hunt.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

const searchId = "e94a7e8a-2f78-40e8-afc8-941d0aab6803";
type Prompt = { inventory: { index: number; listingId: string }[];
    observed: { action: string; listingId: string | null; observation: string }[];
    menu: { key: string; market?: string; evidence?: string; decision?: string; differentCard?: boolean; releaseYear?: number }[] };
function planner(pick: (prompt: Prompt) => string) {
    const cache = new Map();
    return createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            assert.deepEqual(request.photos, []);
            assert.equal(getAiUsageContext().searchId, searchId);
            const prompt = JSON.parse(request.prompt) as Prompt;
            const choice = pick(prompt);
            assert.ok(prompt.menu.some(row => row.key === choice), `Unexpected menu for ${choice}`);
            return { result: { choice, reason: "Check the best remaining lead." }, usage: { inputTokens: 10, outputTokens: 8 } };
        },
    });
}

function rawResale(matched: boolean) {
    const targets = { minProfit: 10, minRoi: 0.20 };
    const evaluation = cardEvaluation(targets);
    const now = Date.now(), stamp = new Date(now).toISOString();
    Object.assign(evaluation.listing, { id: "v1|120000000002|0", buyingOption: "FIXED_PRICE", availability: "ACTIVE",
        price: 25, shipping: 5, termsCheckedAt: stamp });
    Object.assign(evaluation, { pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "offline/bounded-prompts-4",
        conditionVersion: "offline/bounded-condition-1/prompts-1", gradedPricing: null, rawPricing: null });
    evaluation.photoCheck!.cardCount = "ONE";
    if (matched) {
        const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [90, 95, 100]);
        for (const [index, sale] of sales.sales.entries()) {
            sale.title = "Venusaur Base Set 15/102 Unlimited Holo";
            sale.url = `https://www.ebay.com/itm/${120000001000 + index}`;
            sale.saleType = "fixed_price";
            sale.photoCondition = "LIGHTLY_PLAYED";
            sale.conditionEvidence = ["Minor edge wear."];
        }
        evaluation.rawPricing = { status: "PRICED", printing: "UNLIMITED", variant: "holo", source: "pkmnprices", conditionEvidence: "AI_PHOTOS",
            prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 95, updatedAt: stamp, comps: sales }] };
    }
    evaluation.underwriting = underwrite(evaluation, { ...MONEY_CONFIG, targets });
    return dealHuntCandidate(evaluation, "resell", now)!;
}

const selectCopy = (prompt: Prompt, index: number): string => {
    const action = ["check_listing", "inspect_photos", "check_sales", "finish/sales"].find(action =>
        prompt.menu.some(row => row.key === `${index}/${action}`));
    assert.ok(action, "The host must offer a check or an evidence-backed result for the new listing");
    return `${index}/${action}`;
};

test("an expensive copy and an empty market redirect research to a second live market and its checked resale decision", async () => {
    const events: string[] = [];
    const original: DealHuntCandidate = { listingId: "A", title: "Unown A", summary: "One retained copy",
        available: checked => checked.size ? [] : ["check_listing"],
        read: () => "All-in price is above the resale ceiling.",
        outcome: checked => checked.has("check_listing") ? { decision: "WAIT", section: "sales", reason: "Unprofitable at this price." } : null };
    const alternative = rawResale(true);
    const market = (title: string, summary: string, rows: DealHuntCandidate[]): DealHuntMarket => ({
        title, summary, async discover() {
            assert.equal(getAiUsageContext().searchId, searchId);
            events.push(title);
            return rows;
        },
    });
    const markets = [market("Espeon", "7 matched recent transactions.", [original]),
        market("Venusaur", "5 matched recent transactions.", [alternative, alternative]),
        market("Pikachu", "3 matched recent transactions.", [])];
    const model = planner(prompt => {
        if (!prompt.observed.length) return "0/check_listing";
        if (prompt.observed.length === 1) {
            assert.match(prompt.observed[0].observation, /above the resale ceiling/);
            return prompt.menu.find(row => row.evidence?.startsWith("7 matched"))!.key;
        }
        if (prompt.observed.length === 2) {
            assert.equal(prompt.observed[1].listingId, null);
            assert.match(prompt.observed[1].observation, /0 additional/);
            assert.ok(!prompt.menu.some(row => row.market === "Espeon"));
            return prompt.menu.find(row => row.market === "Venusaur")!.key;
        }
        assert.deepEqual(prompt.inventory.map(row => row.listingId), [original.listingId, alternative.listingId]);
        assert.ok(!prompt.menu.some(row => row.market));
        return selectCopy(prompt, 1);
    });
    const initial = [original];
    const result = await runDealHunt({ searchId, goal: "resell", candidates: initial, markets }, undefined, model);
    assert.deepEqual(initial, [original]);
    assert.deepEqual(events, ["Espeon", "Venusaur"]);
    assert.deepEqual(result.steps.filter(step => step.action === "find_listings").map(step => [step.listingId, step.title]), [[null, "Espeon"], [null, "Venusaur"]]);
    assert.deepEqual(result.steps.filter(step => step.listingId === alternative.listingId).map(step => step.action), ["check_listing", "inspect_photos", "check_sales"]);
    assert.equal(result.decision, "BUY", result.reason);
    assert.deepEqual(result.destination, { listingId: alternative.listingId, section: "sales" });
    assert.match(result.reason, /projects \$[\d,.]+ after purchase and selling costs/);
});

test("after two misses the planner can pick a lower-ranked eligible market and reuse all four decisions on replay", async () => {
    const visits: number[] = [];
    const markets = ["Dark Alakazam PSA 9", "Dark Alakazam PSA 8", "Mewtwo PSA 8", "Venusaur holo", "Dark Gengar holo", "Blastoise holo"]
        .map((title, index) => ({ title, cardKey: index < 2 ? "alakazam" : title, releaseYear: [2000, 2000, 1999, 1999, 2002, 1999][index], summary: "Recent matching sales for " + title + ".",
            async discover() { visits.push(index); return []; } }));
    let dispatches = 0;
    const model = planner(prompt => {
        dispatches++;
        const checks = prompt.observed.length;
        if (checks < 2) assert.ok(prompt.menu.every(m => m.releaseYear === undefined && m.differentCard === undefined));
        if (checks >= 2) {
            assert.deepEqual(prompt.menu.map(m => m.releaseYear), checks === 2 ? [2000, 1999, 1999, 1999] : [2000, 1999, 1999]);
            assert.deepEqual(prompt.menu.map(m => m.market), checks === 2
                ? ["Dark Alakazam PSA 8", "Mewtwo PSA 8", "Venusaur holo", "Blastoise holo"]
                : ["Dark Alakazam PSA 8", "Mewtwo PSA 8", "Venusaur holo"]);
            assert.equal(prompt.menu[0].differentCard, false);
            assert.equal(prompt.menu.at(-1)?.differentCard, true);
        }
        // The first two markets miss. Choose the last remaining different card on both pivots.
        return "market-" + [0, 4, 5, 3][checks] + "/find_listings";
    });
    const input = { searchId, goal: "resell" as const, candidates: [], markets, maxSteps: 8 };
    const empty = await runDealHunt(input, undefined, model);
    assert.deepEqual(visits, [0, 4, 5, 3]);
    assert.equal(dispatches, 4);
    assert.ok(empty.steps.every(step => step.selectedBy === "model" && step.reused === false));
    assert.match(empty.reason, /No eligible Buy It Now copy turned up in the 4 markets checked\. Other markets remain/);
    assert.equal(empty.decision, "WAIT"); assert.equal(empty.destination, null);

    visits.length = 0;
    const replay = await runDealHunt(input, undefined, model);
    assert.deepEqual(visits, [0, 4, 5, 3]);
    assert.equal(dispatches, 4);
    assert.ok(replay.steps.every(step => step.selectedBy === "model" && step.reused === true));
});

test("an unreadable market pivot uses the top-ranked different card and records that the app chose it", async () => {
    const cache = new Map();
    let dispatches = 0;
    const model = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            dispatches++;
            const prompt: Prompt = JSON.parse(request.prompt);
            const usage = { inputTokens: 10, outputTokens: 4 };
            if (prompt.observed.length >= 2) throw new MalformedStructuredOutputError(request.step, usage, new SyntaxError());
            return { result: { choice: prompt.menu[0].key, reason: "Check this market's recent sales." }, usage };
        },
    });
    const markets = ["Alakazam PSA 9", "Gengar", "Alakazam PSA 8", "Venusaur"].map((title, index) => ({
        title, cardKey: index === 2 ? "Alakazam PSA 9" : title, summary: "Matching sold records.", discover: async () => [],
    }));
    const run = () => runDealHunt({ searchId, goal: "resell", candidates: [], markets }, undefined, model);
    const first = await run();
    assert.deepEqual(first.steps.map(step => [step.title, step.selectedBy]), [
        ["Alakazam PSA 9", "model"], ["Gengar", "model"], ["Venusaur", "app"], ["Alakazam PSA 8", "app"],
    ]);
    assert.match(first.steps[2].reason, /unreadable choice/);
    assert.equal(first.steps[3].reused, null);
    const replay = await run();
    assert.equal(dispatches, 3);
    assert.equal(replay.steps[2].reused, true);
    assert.equal(replay.steps[2].selectedBy, "app");
});

test("a fourth market can surface a supported flip and a listing with insufficient sales still yields Wait", async () => {
    const alternative = rawResale(true);
    const visits: number[] = [];
    const markets = [0, 1, 2, 3, 4].map(index => ({
        title: `Market ${index}`, summary: "Recent matched sales.",
        async discover() { visits.push(index); return index === 3 ? [alternative] : []; },
    }));
    const result = await runDealHunt({ searchId, goal: "resell", candidates: [], markets }, undefined,
        planner(prompt => prompt.inventory.length ? selectCopy(prompt, 0) : prompt.menu[0].key));
    assert.deepEqual(visits, [0, 1, 2, 3]);
    assert.deepEqual(result.steps.slice(4).map(step => step.action), ["check_listing", "inspect_photos", "check_sales"]);
    assert.equal(result.decision, "BUY", result.reason);
    assert.deepEqual(result.destination, { listingId: alternative.listingId, section: "sales" });
    const unpriced = rawResale(false);
    const noSale = await runDealHunt({ searchId, goal: "resell", candidates: [],
        markets: [{ ...markets[0], discover: async () => [unpriced] }] }, undefined, planner(prompt => selectCopy(prompt, 0)));
    assert.equal(noSale.decision, "WAIT");
    assert.match(noSale.reason, /No matching/);
    assert.ok(noSale.steps.some(step => step.action === "check_sales" && step.listingId === unpriced.listingId));
});


test("eBay quota stops retain completed observations, while an accounting failure surfaces", async () => {
    const markets: DealHuntMarket[] = [
        { title: "Espeon", summary: "Historical sales.", discover: async () => [] },
        { title: "Scizor", summary: "Historical sales.", discover: async () => { throw new EbayBudgetError("Reserve reached.", "QUOTA"); } },
    ];
    const input = { searchId, goal: "resell" as const, candidates: [], markets };
    const choose = planner(prompt => prompt.menu[0].key);
    const result = await runDealHunt(input, undefined, choose);
    assert.equal(result.decision, "WAIT");
    assert.equal(result.destination, null);
    assert.match(result.reason, /eBay listing allowance/);
    assert.deepEqual(result.steps.map(step => [step.action, step.title]), [["find_listings", "Espeon"]]);
    const badLedger = new EbayBudgetError("Could not read eBay counts.", "ACCOUNTING");
    markets[1].discover = async () => { throw badLedger; };
    await assert.rejects(runDealHunt(input, undefined, choose), badLedger);
});

test("an auction grading loss offers both a raw exit and a different liquid market with time to verify it", async () => {
    const checks = ["check_listing", "inspect_photos", "check_sales", "calculate_grading"] as const;
    const optionsAtLoss: string[] = [];
    const markets: DealHuntMarket[] = ["Espeon", "Ampharos"].map((title, index) => ({
        title, summary: "Repeated matched auction sales.",
        discover: async () => [{
            title, listingId: title, summary: "Raw holo auction inside ten hours",
            available: checked => [...checks.filter(action => !checked.has(action)), "check_raw_resale"],
            read: action => !index && action === "calculate_grading" ? "Grading costs erase the profit." : "Verified.",
            outcome: checked => index && checks.every(action => checked.has(action))
                ? { decision: "BID", section: "grading", reason: "The next bid fits the confirmed grading ceiling." } : null,
        }],
    }));
    const result = await runDealHunt({ searchId, goal: "resell", auction: true, candidates: [], markets }, undefined,
        planner(({ inventory, observed, menu }) => {
            if (!inventory.length) return "market-0/find_listings";
            if (observed.at(-1)?.observation.includes("erase")) {
                optionsAtLoss.push(...menu.map(row => row.key));
                return "market-1/find_listings";
            }
            const index = inventory.length - 1;
            return [...checks, "finish/grading"].map(action => `${index}/${action}`).find(key => menu.some(row => row.key === key))!;
        }));
    assert.ok(optionsAtLoss.includes("0/check_raw_resale"));
    assert.ok(optionsAtLoss.includes("market-1/find_listings"));
    assert.equal(result.decision, "BID");
    assert.equal(result.destination?.listingId, "Ampharos");
    assert.equal(result.steps.length, 10);
});
