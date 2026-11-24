import "../fixtures/isolated-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchInterpreter, SearchPlanInputError, validateSearchPlan } from "../../server/search/search-plan.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { AiSpendingError } from "../../server/ai/spending.ts";

const knownSets = ["Base Set", "Base Set 2", "Neo Genesis", "Neo Revelation", "Neo Discovery", "Neo Destiny", "Evolving Skies"];
const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "all" as const };
const baseIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, grader: null,
    minGrade: null, maxGrade: null, finish: null, minYear: null, maxYear: null };
function reading(intent = {}, rest = {}) {
    return { workflow: "named_search", query: "AI refined search", intent: { ...baseIntent, ...intent }, setMentions: [],
        goal: null, format: "FIXED_PRICE", minProfit: null, maxDelivered: null, summary: "Search the requested cards.", ...rest };
}
const validate = (result: unknown, query: string) => validateSearchPlan(result, { query, filters }, knownSets);

test("a search plan cannot shorten a requested Dark or owner-qualified card name", () => {
    for (const [name, shortened] of [["Dark Charizard", "Charizard"], ["Light Arcanine", "Arcanine"],
        ["Rocket's Mewtwo", "Mewtwo"], ["Charizard ex", "Charizard"]]) {
        const query = `find a deal on ${name}`;
        assert.equal(validate(reading({ cardName: name }), query).intent.cardName, name);
        assert.throws(() => validate(reading({ cardName: shortened }), query), /omitted part.*name|form/);
    }
});

test("a broad hunt passes explicit printing and certified grade constraints to its executable preferences", () => {
    const request = "find first edition holo cards from 1999-2003";
    const first = validate(reading({ printing: "FIRST_EDITION", finish: "HOLO", minYear: 1999, maxYear: 2003 },
        { workflow: "market_hunt", goal: "resell" }), request);
    assert.equal(first.marketPreferences.printing, "FIRST_EDITION");
    const slabs = validate(reading({ printing: "UNLIMITED", finish: "HOLO", graded: true, grader: "CGC", minGrade: 8, maxGrade: 9.5 },
        { workflow: "market_hunt", goal: "resell" }), "find unlimited holo cards CGC 8 to 9.5");
    assert.equal(slabs.marketPreferences.printing, "UNLIMITED");
    assert.equal(slabs.marketPreferences.grader, "CGC");
    assert.equal(slabs.marketPreferences.minGrade, 8);
    assert.equal(slabs.marketPreferences.maxGrade, 9.5);
});

test("a named year search always uses the AI interpretation and compiles canonical downstream keywords", () => {
    const result = validate(reading({ cardName: "Venusaur", minYear: 1999, maxYear: 1999 },
        { query: "1999 Venusaur fixed price" }), "1999 venusaur");
    assert.equal(result.workflow, "named_search");
    assert.equal(result.query, "1999 Venusaur");
    assert.equal(result.intent.source, "ai");
    assert.equal(result.intent.minYear, 1999);
    assert.equal(result.intent.finish, null);
});

test("broad liquid-card wording preserves years and finish without becoming literal marketplace terms", () => {
    const result = validate(reading({ minYear: 1999, maxYear: 2003, finish: "HOLO" }, { workflow: "market_hunt", goal: "resell" }),
        "find me a deal on a pokemon card holo that is liquid from 1999-2003");
    assert.equal(result.workflow, "market_hunt");
    assert.equal(result.query, "1999-2003 holo");
    assert.deepEqual(result.marketPreferences, { minYear: 1999, maxYear: 2003, finish: "HOLO" });
});

test("a catalog-supported set typo becomes live set discovery with no fabricated collector number", () => {
    const result = validate(reading({ sets: ["Neo Revelation"], finish: "HOLO" }, { workflow: "market_hunt", goal: "resell",
        setMentions: [{ text: "neo revolution", name: "Neo Revelation" }] }), "find a deal on a holo card form neo revolution");
    assert.equal(result.workflow, "named_search");
    assert.equal(result.query, "Neo Revelation holo");
    assert.deepEqual(result.marketPreferences.sets, ["Neo Revelation"]);
    assert.equal(result.intent.cardNumber, null);
    assert.throws(() => validateSearchPlan(reading({ sets: ["Neo Revelation"], finish: "HOLO" }, {
        setMentions: [{ text: "neo revolution", name: "Neo Revelation" }] }), { query: "neo revolution holo", filters },
        [...knownSets, "Neo Revolution"]), /matched safely/);
});

test("a particular card with a resale goal cannot be turned into a cross-card hunt", () => {
    const result = validate(reading({ cardName: "Venusaur", minYear: 1999, maxYear: 1999 }, { goal: "resell" }),
        "find a deal on 1999 Venusaur");
    assert.equal(result.workflow, "named_search");
    assert.equal(result.intent.cardName, "Venusaur");
    assert.throws(() => validate(reading({ minYear: 1999, maxYear: 1999 }, { workflow: "market_hunt", goal: "resell" }),
        "find a deal on 1999 Venusaur"), /card|variant/);
});

test("named keywords retain printing, exact fraction, finish and requested slab-grade bounds", () => {
    const result = validate(reading({ cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: "UNLIMITED",
        finish: "HOLO", graded: true, grader: "PSA", minGrade: 8, maxGrade: 10, minYear: 1999, maxYear: 1999 },
    { setMentions: [{ text: "Base Set", name: "Base Set" }] }), "1999 Base Set Venusaur 15/102 Unlimited holo PSA 8 or better");
    assert.equal(result.query, "1999 Venusaur 15/102 Base Set Unlimited holo PSA 8-10");
});

test("an interpreter cannot add or remove years, grades, printing, finish or the collector number", () => {
    const good = reading({ cardName: "Venusaur", cardNumber: "15/102", finish: "HOLO", minYear: 1999, maxYear: 1999 });
    const query = "1999 Venusaur 15/102 holo";
    for (const change of [{ minYear: 2000, maxYear: 2000 }, { minYear: null, maxYear: null }, { cardNumber: "15/130" },
        { printing: "FIRST_EDITION" }, { grader: "PSA", minGrade: 9, maxGrade: 9, graded: true }, { finish: null }]) {
        assert.throws(() => validate({ ...good, intent: { ...good.intent, ...change } }, query), SearchPlanInputError);
    }
});

test("separate budget and profit amounts must both survive interpretation", () => {
    const query = "find holo auctions from 2021 to 2024 under $100 delivered with at least $25 profit";
    const good = reading({ minYear: 2021, maxYear: 2024, finish: "HOLO" },
        { workflow: "market_hunt", goal: "resell", format: "AUCTION", minProfit: 25, maxDelivered: 100 });
    const result = validate(good, query);
    assert.equal(result.minProfit, 25);
    assert.equal(result.maxDelivered, 100);
    for (const change of [{ minProfit: null }, { maxDelivered: null }, { minProfit: 100 }, { maxDelivered: 200 }])
        assert.throws(() => validate({ ...good, ...change }, query), /price|profit/);
});

test("natural maximum-budget wording is retained and cannot silently disappear", () => {
    for (const phrase of ["less than", "no more than"]) {
        const query = `find holo cards ${phrase} $100 delivered`;
        const good = reading({ finish: "HOLO" }, { workflow: "market_hunt", goal: "resell", maxDelivered: 100 });
        assert.equal(validate(good, query).maxDelivered, 100);
        assert.throws(() => validate({ ...good, maxDelivered: null }, query), /omitted.*price/);
    }
});

test("unrequested zero limits are normalized without changing explicit zero amounts or accepted answers", () => {
    const saved = reading({ cardName: "Venusaur", minYear: 1999, maxYear: 1999 }, { minProfit: 0, maxDelivered: 0 });
    const snapshot = structuredClone(saved);
    const noLimit = validate(saved, "1999 Venusaur");
    assert.equal(noLimit.minProfit, null);
    assert.equal(noLimit.maxDelivered, null);
    assert.deepEqual(saved, snapshot, "normalization must preserve the accepted cached reading");
    const explicitBudget = validate(reading({ cardName: "Venusaur" }, { minProfit: 0, maxDelivered: 0 }), "Venusaur under $0 delivered");
    assert.equal(explicitBudget.maxDelivered, 0);
    assert.equal(explicitBudget.minProfit, null);
    const explicitProfit = validate(reading({ finish: "HOLO" }, { workflow: "market_hunt", goal: "resell", minProfit: 0, maxDelivered: 0 }),
        "find holo cards with at least $0 profit");
    assert.equal(explicitProfit.minProfit, 0);
    assert.equal(explicitProfit.maxDelivered, null);
    assert.throws(() => validate({ ...saved, maxDelivered: 100 }, "1999 Venusaur"), /added.*price/);
    assert.throws(() => validate({ ...saved, minProfit: 25 }, "1999 Venusaur"), /added.*price|profit/);
});

test("explicit auction wording overrides the selected default and an unrequested format cannot be introduced", () => {
    const good = reading({ cardName: "Venusaur" }, { format: "AUCTION" });
    assert.equal(validate(good, "Venusaur auctions").format, "AUCTION");
    assert.throws(() => validate(good, "Venusaur"), /format/);
});

test("the exact raw submission goes to OpenAI and identical submissions reuse their accepted answer", async () => {
    const saved = new Map<string, unknown>();
    const requests: { prompt: string }[] = [];
    const run = createModelExperimentRunner({ cached: async key => saved.get(key) ?? null,
        save: async (key, value) => { saved.set(key, value); },
        run: async request => {
            requests.push(request);
            return { result: reading({ cardName: "Venusaur", minYear: 1999, maxYear: 1999 }), usage: { inputTokens: 100, outputTokens: 100 } };
        } });
    const interpreter = createSearchInterpreter({ run, setNames: async () => knownSets });
    const input = { query: "  1999 Venusaur  ", filters };
    const first = await withAiUsageContext({ searchId: "a498c2b9-2aa4-41e9-9bcc-b2caad2da99a" }, () => interpreter(input));
    const second = await withAiUsageContext({ searchId: "8231a7e6-7029-4404-a3c2-68da45fd0fef" }, () => interpreter(input));
    assert.deepEqual(first, second);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].prompt).submittedText, input.query);
});

test("an unavailable AI interpretation fails visibly and cannot launch a regex fallback", async () => {
    const failure = new Error("provider unavailable");
    const interpreter = createSearchInterpreter({ setNames: async () => knownSets,
        run: async () => { throw failure; } });
    await assert.rejects(interpreter({ query: "Venusaur", filters }), error => error instanceof SearchPlanInputError && error.status === 503);
    const guard = new AiSpendingError("AI_BUDGET", "Search paused");
    const paused = createSearchInterpreter({ setNames: async () => knownSets, run: async () => { throw guard; } });
    await assert.rejects(paused({ query: "Venusaur", filters }), error => error === guard);
});

test("cancellation prevents interpretation dispatch", async () => {
    const controller = new AbortController(); controller.abort(new Error("buyer cancelled"));
    let calls = 0;
    const interpreter = createSearchInterpreter({ setNames: async () => knownSets, run: async () => { calls++; throw new Error("unexpected dispatch"); } });
    await assert.rejects(interpreter({ query: "Venusaur", filters }, controller.signal), /buyer cancelled/);
    assert.equal(calls, 0);
});
