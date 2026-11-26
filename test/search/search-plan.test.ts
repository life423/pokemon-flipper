import "../fixtures/isolated-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchInterpreter, SearchPlanInputError, validateSearchPlan } from "../../server/search/search-plan.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { AiSpendingError } from "../../server/ai/spending.ts";
import { TEXT_MODEL } from "../../server/ai/policy.ts";

const knownSets = ["Base Set", "Base Set 2", "Neo Genesis", "Neo Revelation", "Neo Discovery", "Neo Destiny", "Evolving Skies", "Aquapolis", "Skyridge"];
const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "all" as const };
const baseIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, grader: null,
    minGrade: null, maxGrade: null, finish: null, minYear: null, maxYear: null };
function reading(intent = {}, rest = {}) {
    return { workflow: "named_search", query: "AI refined search", intent: { ...baseIntent, ...intent }, setMentions: [],
        goal: null, format: "FIXED_PRICE", minProfit: null, maxDelivered: null, summary: "Search the requested cards.", ...rest };
}
const validate = (result: unknown, query: string) => validateSearchPlan(result, { query, filters }, knownSets);

test("a collector fraction repeated as a release year is repaired from the submitted words", () => {
    const query = "Charizard ex 199/165, Buy It Now only";
    const answer = reading({ cardName: "Charizard ex", cardNumber: "199/165", minYear: 199, maxYear: 199 }, {
        subjectMentions: [{ kind: "CARD", text: "Charizard ex 199/165", cardName: "Charizard ex" }],
        maxDelivered: 250, summary: "Charizard ex from 199.",
    });
    const result = validateSearchPlan(answer, { query, filters: { ...filters, maxPrice: 250 } }, knownSets);
    assert.equal(result.query, "Charizard ex 199/165");
    assert.equal(result.intent.minYear, undefined);
    assert.equal(result.summary, result.query);
    assert.throws(() => validateSearchPlan(answer, { query, filters }, knownSets), /price or profit/);
    assert.throws(() => validateSearchPlan(answer, { query: query + " from 2020", filters }, knownSets), /year/);
});

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
    assert.deepEqual(result.marketPreferences, { minYear: 1999, maxYear: 2003, finish: "HOLO", preferRecentSales: true });
});

test("source-linked descriptions let AI interpret unfamiliar buying goals without inventing a card", () => {
    for (const [query, description] of [
        ["find me an underpriced pokemon card", "underpriced"],
        ["find a pokemon card with resale potential", "resale potential"],
        ["find pokemon cards I can make money on", "make money"],
        ["find me a card with a good margin", "good margin"],
    ]) {
        const result = reading({}, { workflow: "market_hunt", goal: "resell",
            subjectMentions: [{ kind: "DESCRIPTION", text: description, cardName: null }] });
        const plan = validate(result, query);
        assert.equal(plan.workflow, "market_hunt", query);
        assert.equal(plan.query, "pokemon", query);
        assert.equal(plan.intent.cardName, null, query);
        assert.equal(plan.goal, "resell", query);
    }
});

test("semantic descriptions cannot invent source words or remove a named form, collector number or typed constraint", () => {
    const description = (text: string) => ({ kind: "DESCRIPTION", text, cardName: null });
    const broad = (subjectMentions: unknown[]) => reading({}, { workflow: "market_hunt", goal: "resell", subjectMentions });
    assert.throws(() => validate(broad([description("resale potential")]), "find an underpriced pokemon card"), /original words/);
    for (const [query, mentions] of [
        ["find Dark Charizard", [description("Dark Charizard")]],
        ["find Dark Charizard", [description("Dark"), description("Charizard")]],
        ["find Rocket's Mewtwo", [description("Rocket's Mewtwo")]],
        ["find Charizard ex", [description("Charizard ex")]],
        ["find a card 15/102", [description("15/102")]],
    ] as const) assert.throws(() => validate(broad([...mentions]), query), /name|form|number/, query);
    const card = { kind: "CARD", text: "Dark Charizard", cardName: "Dark Charizard" };
    const query = "find an underpriced Dark Charizard holo from 1999-2003 under $100 delivered";
    const response = reading({ cardName: "Dark Charizard", finish: "HOLO", minYear: 1999, maxYear: 2003 },
        { goal: "resell", maxDelivered: 100, subjectMentions: [description("underpriced"), card] });
    const plan = validate(response, query);
    assert.equal(plan.query, "1999-2003 Dark Charizard holo");
    assert.equal(plan.maxDelivered, 100);
    assert.throws(() => validate({ ...response, intent: { ...response.intent, cardName: "Charizard" } }, query), /omitted.*card|name|form/);
    assert.throws(() => validate({ ...response, intent: { ...response.intent, maxYear: null } }, query), /year/);
    assert.throws(() => validate(broad([description("underpriced"), card]), "find underpriced Dark Charizard"), /omitted.*card/);
    assert.throws(() => validate(broad([]), "Ancient Years holo from the years 1999-2003"), /card|year/);
});

test("positive buyer liquidity wording sets the preference and model prose cannot add it", () => {
    const broad = reading({}, { workflow: "market_hunt", goal: "resell", summary: "Find liquid cards for resale." });
    for (const source of ["find liquid cards for resale", "find cards with liquidity for resale"]) {
        assert.equal(validate(broad, source).marketPreferences.preferRecentSales, true, source);
    }
    for (const source of ["find cards for resale", "find non-liquid cards for resale", "find cards for resale, liquidity doesn't matter",
        "find cards for resale, ignore liquidity"]) {
        assert.equal(validate(broad, source).marketPreferences.preferRecentSales, undefined, source);
    }
});

test("natural wording around explicit release years does not invent a card or remove a named form", () => {
    const period = { minYear: 1999, maxYear: 2003, finish: "HOLO" };
    const broad = reading(period, { workflow: "market_hunt", goal: "resell" });
    for (const query of ["find me a card to flip from the years 1999-2003 that is holographic and liquid",
        "find holographic cards to resell between the release years 1999 and 2003",
        "find holographic cards released during the years 1999 through 2003 to flip"]) {
        const plan = validate(broad, query);
        assert.equal(plan.query, "1999-2003 holo");
        assert.equal(plan.workflow, "market_hunt");
        assert.equal(plan.goal, "resell");
        assert.equal(plan.intent.cardName, null);
        assert.equal(plan.intent.minYear, 1999);
        assert.equal(plan.intent.maxYear, 2003);
        assert.equal(plan.intent.finish, "HOLO");
        assert.throws(() => validate({ ...broad, intent: { ...broad.intent, maxYear: 2002 } }, query), /requested.*year/);
    }
    const named = "Dark Charizard holo from the years 1999-2003";
    assert.equal(validate(reading({ ...period, cardName: "Dark Charizard" }), named).query, "1999-2003 Dark Charizard holo");
    assert.throws(() => validate(broad, named), /omitted a requested card/);
    assert.throws(() => validate(reading({ ...period, cardName: "Charizard" }), named), /omitted part/);
    assert.throws(() => validate(broad, "Ancient Years holo from the years 1999–2003"), /omitted a requested card/);
});

test("open-ended release constraints preserve inclusive and exclusive meaning through compilation", () => {
    for (const [source, bounds, compiled] of [
        ["holo card no newer than 2020", { maxYear: 2020 }, "Through 2020 holo"],
        ["holo card no older than 2010", { minYear: 2010 }, "Since 2010 holo"],
        ["holo card released before the year 2020", { maxYear: 2019 }, "Through 2019 holo"],
        ["holo card released after 2010", { minYear: 2011 }, "Since 2011 holo"],
        ["holo card since 2010", { minYear: 2010 }, "Since 2010 holo"],
        ["holo card until 2020", { maxYear: 2020 }, "Through 2020 holo"],
        ["holo card since 2010 and before 2020", { minYear: 2010, maxYear: 2019 }, "2010-2019 holo"],
    ] as const) {
        for (const workflow of ["named_search", "market_hunt"]) {
            const plan = validate(reading({ finish: "HOLO", ...bounds }, { workflow, goal: workflow === "market_hunt" ? "resell" : null }), source);
            assert.equal(plan.query, compiled, source);
            assert.equal(plan.intent.minYear, "minYear" in bounds ? bounds.minYear : undefined, source);
            assert.equal(plan.intent.maxYear, "maxYear" in bounds ? bounds.maxYear : undefined, source);
            assert.deepEqual(plan.marketPreferences, { ...bounds, finish: "HOLO" }, source);
        }
    }
});

test("year comparators cannot widen named searches or consume prices or collector numbers", () => {
    const old = reading({ finish: "HOLO", maxYear: 2020 }, { workflow: "market_hunt", goal: "resell" });
    const query = "Dark Charizard holo no newer than 2020";
    assert.equal(validate(reading({ finish: "HOLO", maxYear: 2020, cardName: "Dark Charizard" }), query).query, "Through 2020 Dark Charizard holo");
    assert.throws(() => validate(old, query), /omitted a requested card/);
    assert.throws(() => validate(reading({ finish: "HOLO", maxYear: 2020, cardName: "Charizard" }), query), /omitted part/);
    for (const change of [{ minYear: 1900 }, { maxYear: null }, { maxYear: 2021 }, { minYear: 2021 }]) {
        assert.throws(() => validate({ ...old, intent: { ...old.intent, ...change } }, "holo card no newer than 2020"), /year/);
    }
    assert.throws(() => validate(old, "holo card since 2021 and before 2020"), /release years conflict/);
    assert.throws(() => validate(old, "holo card before 2020"), /year/);
    assert.throws(() => validate(old, "holo card during 2021-2010"), /release years conflict/);
    for (const query of ["Pikachu since 2021 and before 2020", "Pikachu before 1900", "Pikachu after 2100", "Pikachu before 2020 2010"]) {
        assert.throws(() => validate(reading({ cardName: "Pikachu" }), query), /release years/, query);
    }
    const number = validate(reading({ cardName: "Pikachu", cardNumber: "2020/2030" }), "Pikachu #2020 / 2030");
    assert.equal(number.intent.cardNumber, "2020/2030");
    assert.deepEqual(number.marketPreferences, {});
    assert.equal(validate(reading({ finish: "HOLO" }, { maxDelivered: 2020 }), "holo card under $ 2020").maxDelivered, 2020);
});

test("the accepted upper-only search interpretation can replay without another AI request", async () => {
    const body = reading({ finish: "HOLO", maxYear: 2020 });
    const cache = new Map<string, unknown>();
    let calls = 0;
    const run = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async () => { calls++; return { result: body, usage: { inputTokens: 10, outputTokens: 10 } }; },
    });
    const interpreter = createSearchInterpreter({ run, setNames: async () => knownSets });
    for (const id of ["a498c2b9-2aa4-41e9-9bcc-b2caad2da99a", "8231a7e6-7029-4404-a3c2-68da45fd0fef"]) {
        const plan = await withAiUsageContext({ searchId: id }, () => interpreter({ query: "holo card no newer than 2020", filters }));
        assert.deepEqual(plan.marketPreferences, { maxYear: 2020, finish: "HOLO" });
        assert.equal(plan.query, "Through 2020 holo");
    }
    assert.equal(calls, 1);
    assert.equal(body.intent.minYear, null);
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

test("ordinary exact set searches recover a misfiled release and accept adjacent set wording", () => {
    const bare = reading({ cardName: "Aquapolis" }, { query: "Aquapolis fixed price", maxDelivered: 0 });
    const before = structuredClone(bare);
    const framed = reading({ sets: ["Aquapolis"] }, { goal: "resell", setMentions: [{ text: "Aquapolis", name: "Aquapolis" }] });
    for (const [source, response] of [["Aquapolis", bare], ["Pokemon cards from the Aquapolis set", framed],
        ["Pokemon cards from the Aquapolis set", reading()], ["find holo cards from the Neo-Genesis set",
            reading({ finish: "HOLO" })]] as const) {
        const release = source.includes("Neo") ? "Neo Genesis" : "Aquapolis";
        const plan = validate(response, source);
        assert.equal(plan.workflow, "named_search");
        assert.equal(plan.intent.cardName, null);
        assert.equal(plan.intent.cardNumber, null);
        assert.equal(plan.maxDelivered, null);
        assert.equal(plan.intent.source, "ai");
        assert.deepEqual(plan.intent.sets, [release]);
        assert.equal(plan.query, source.includes("holo") ? `${release} holo` : release);
    }
    assert.deepEqual(bare, before, "use the saved accepted interpreter result without mutating it");
});

test("an exact set frame preserves named cards, printed variants and explicit collector numbers", () => {
    const setMentions = [{ text: "Aquapolis", name: "Aquapolis" }];
    const full = reading({ cardName: "Porygon2", sets: ["Aquapolis"] }, { setMentions });
    assert.equal(validate(full, "Pokemon Porygon2 cards from the Aquapolis set").query, "Porygon2 Aquapolis");
    const numbered = reading({ cardNumber: "H9/H32", sets: ["Aquapolis"] }, { setMentions });
    assert.equal(validate(numbered, "Aquapolis set H9/H32").query, "H9/H32 Aquapolis");
    const request = "Show me Dark Charizard from the Aquapolis set";
    assert.equal(validate(reading({ cardName: "Dark Charizard", sets: ["Aquapolis"] }, { setMentions }), request).intent.cardName, "Dark Charizard");
    assert.throws(() => validate(reading({ cardName: "Charizard", sets: ["Aquapolis"] }, { setMentions }), request), /omitted part/);
});

test("release recovery cannot discard a different requested set, an unknown word or a conflicting model identity", () => {
    const aquapolis = { text: "Aquapolis", name: "Aquapolis" }, skyridge = { text: "Skyridge", name: "Skyridge" };
    for (const request of ["Aquapolis and Skyridge", "Aquapolis holographic Merely", "Pokemon card set"]) {
        assert.throws(() => validate(reading(), request), /omitted.*card/);
    }
    assert.throws(() => validate(reading({ sets: ["Aquapolis"] }, { setMentions: [aquapolis] }), "Aquapolis and Skyridge"), /omitted.*card/);
    assert.throws(() => validate(reading({ sets: ["Skyridge"] }, { setMentions: [skyridge] }), "Aquapolis"), /matched safely/);
    assert.throws(() => validate(reading({ cardName: "Espeon" }), "Aquapolis"), /changed.*identity/);
    assert.throws(() => validate(reading({ cardName: "set", sets: ["Aquapolis"] }, { setMentions: [aquapolis] }), "Aquapolis set"), /changed.*identity/);
    assert.throws(() => validate(reading({ cardName: "Aquapolis", sets: ["Aquapolis"] }, { setMentions: [aquapolis] }), "Aquapolis unknown subject"), /refined search|omitted/);
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

test("Both retains executable Buy It Now and auction formats without requiring an impossible single format", () => {
    const broad = reading({ finish: "HOLO" }, { workflow: "market_hunt", goal: "resell" });
    for (const format of ["FIXED_PRICE", "AUCTION"] as const) {
        const plan = validate({ ...broad, format }, "find holo cards in buy it now or auctions");
        assert.deepEqual(plan.listingFormats, ["FIXED_PRICE", "AUCTION"]);
        assert.equal(plan.format, format, "legacy consumers retain a valid primary format");
    }
    const all = { ...filters, typeFilter: "all" as const };
    assert.deepEqual(validateSearchPlan(broad, { query: "find holo cards", filters: all }, knownSets).listingFormats,
        ["FIXED_PRICE", "AUCTION"]);
    assert.deepEqual(validateSearchPlan({ ...broad, format: "AUCTION" }, { query: "find holo auctions", filters: all }, knownSets).listingFormats,
        ["AUCTION"], "an explicit single format takes precedence over the Both control");
    assert.deepEqual(validate(broad, "find holo cards in both formats").listingFormats, ["FIXED_PRICE", "AUCTION"]);
    assert.throws(() => validate({ ...broad, format: "AUCTION" }, "find holo buy it now cards"), /format/);
});

test("compatible accepted v1 interpretations are read without dispatching the new semantic request", async () => {
    const saved = reading({ cardName: "Venusaur", minYear: 1999, maxYear: 1999 });
    const original = structuredClone(saved);
    let calls = 0, reads = 0;
    const interpret = createSearchInterpreter({ setNames: async () => knownSets,
        cached: async key => { reads++; return { version: 1, key, model: TEXT_MODEL, answeredAt: new Date().toISOString(), result: saved,
            usage: { inputTokens: 100, outputTokens: 100 } }; },
        run: async () => { calls++; throw new Error("A compatible accepted answer must not be bought again"); } });
    const plan = await interpret({ query: "1999 Venusaur", filters });
    assert.equal(plan.intent.cardName, "Venusaur");
    assert.equal(reads, 1); assert.equal(calls, 0);
    assert.deepEqual(saved, original);
});

test("an incompatible legacy wording uses the new subject contract, while corrupt accepted records fail closed", async () => {
    const old = reading({}, { workflow: "market_hunt", goal: "resell" });
    let calls = 0;
    const interpret = createSearchInterpreter({ setNames: async () => knownSets,
        cached: async key => ({ version: 1, key, model: TEXT_MODEL, answeredAt: new Date().toISOString(), result: old,
            usage: { inputTokens: 100, outputTokens: 100 } }),
        run: async options => {
            calls++;
            assert.equal(options.sourceKey, "submitted-search-plan:v2");
            assert.ok(options.request.schema.required.includes("subjectMentions"));
            return { result: { ...old, subjectMentions: [{ kind: "DESCRIPTION", text: "underpriced", cardName: null }] },
                usage: { inputTokens: 100, outputTokens: 100 }, reused: false, answeredAt: new Date().toISOString(), key: "mock" };
        } });
    assert.equal((await interpret({ query: "find an underpriced pokemon card", filters })).workflow, "market_hunt");
    assert.equal(calls, 1);
    const corrupt = createSearchInterpreter({ setNames: async () => knownSets, cached: async () => ({ version: 1, key: "wrong" }),
        run: async () => { throw new Error("Corrupt saved evidence cannot authorize new work"); } });
    await assert.rejects(corrupt({ query: "find an underpriced pokemon card", filters }), { code: "STORAGE_UNAVAILABLE" });
    const malformed = createSearchInterpreter({ setNames: async () => knownSets,
        cached: async key => ({ version: 1, key, model: TEXT_MODEL, answeredAt: new Date().toISOString(), result: null,
            usage: { inputTokens: 100, outputTokens: 100 } }),
        run: async () => { throw new Error("A malformed paid response cannot authorize replacement work"); } });
    await assert.rejects(malformed({ query: "find an underpriced pokemon card", filters }), /incomplete search plan/);
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

test("liquidity is recovered on every read of the original accepted interpretation without a paid repeat", async () => {
    const oldBody = reading({ minYear: 1999, maxYear: 2003, finish: "HOLO" }, { workflow: "market_hunt", goal: "resell" });
    const saved = new Map<string, unknown>();
    let calls = 0;
    const run = createModelExperimentRunner({
        cached: async key => saved.get(key) ?? null,
        save: async (key, result) => { saved.set(key, result); },
        run: async () => {
            calls++;
            return { result: oldBody, usage: { inputTokens: 100, outputTokens: 100 } };
        },
    });
    const interpret = createSearchInterpreter({ run, setNames: async () => knownSets });
    const input = { query: "find me a card to flip from the years 1999-2003 that is holographic and liquid", filters };
    for (const id of ["a498c2b9-2aa4-41e9-9bcc-b2caad2da99a", "8231a7e6-7029-4404-a3c2-68da45fd0fef"]) {
        const plan = await withAiUsageContext({ searchId: id }, () => interpret(input));
        assert.deepEqual(plan.marketPreferences, { minYear: 1999, maxYear: 2003, finish: "HOLO", preferRecentSales: true });
    }
    assert.equal(calls, 1);
    assert.equal(Object.hasOwn(oldBody, "marketPreferences"), false);
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
