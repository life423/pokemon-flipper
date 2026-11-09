import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { marketplaceQuery } from "../../shared/search-criteria.ts";
import { withAiUsageContext, getAiUsageContext } from "../../server/ai/usage-context.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { createQueryAssistance } from "../../server/search/query-assistance.ts";

const local = async (search: string) => readSearchLocally(search);
const search = "I'm trying to track down Dark Blastoise Team Rocket #3 reverse holo 1st Edition CGC between eight and 9.5";
const compact = "Dark Blastoise Team Rocket #3 reverse holo 1st Edition CGC between eight and 9.5";

function mockAssistance(reply: unknown) {
    const saved = new Map<string, unknown>();
    const calls: unknown[] = [];
    const run = createModelExperimentRunner({
        cached: async key => saved.get(key) ?? null,
        save: async (key, value) => { saved.set(key, value); },
        run: async request => {
            assert.equal(request.bounded, true);
            assert.equal(request.maxRetries, 0);
            assert.ok(request.maxOutputTokens! <= 180);
            assert.deepEqual(request.photos, []);
            assert.ok(getAiUsageContext().searchId);
            calls.push(JSON.parse(request.prompt).search);
            return { result: reply, usage: { inputTokens: 80, outputTokens: 20 } };
        },
    });
    return { read: createQueryAssistance({ local, run }), calls, saved };
}

test("literal searches, known aliases, and already-removed conversational wording stay free", async () => {
    const { read, calls } = mockAssistance({ phrase: null });
    await withAiUsageContext({ searchId: randomUUID() }, async () => {
        for (const text of ["Charizard 1999 Base Set holo", "find me deals on raw Dark Blastoise Team Rocket non-holo",
            "Aquapolis PSA 7 or better holo", "Origin Forme Palkia VSTAR", "Base Set holo", "4/102", "Japanese Charizard"]) {
            assert.deepEqual(await read(text), readSearchLocally(text), text);
        }
        const zard = await read("zard 1999 baseset 4/102 holo");
        assert.equal(zard.cardName, "charizard");
        assert.deepEqual(zard.sets, ["Base Set"]);
        assert.equal(zard.cardNumber, "4/102");
        const moonbreon = await read("Moonbreon");
        assert.equal(moonbreon.cardName, "umbreon vmax");
        assert.equal(moonbreon.cardNumber, null, "only a literal or catalog-derived number can filter listings");
        assert.equal(marketplaceQuery("Moonbreon", moonbreon), "umbreon vmax alt art evolving skies");
        assert.deepEqual(await read("Moonbreon Base Set"), readSearchLocally("Moonbreon Base Set"));
        assert.equal((await read("Moonbreon baseset")).cardName, "moonbreon");
        assert.deepEqual(await read("Moonbreon Evolving Skies #94"), readSearchLocally("Moonbreon Evolving Skies #94"));
    });
    assert.deepEqual(calls, []);
});

test("bounded assistance cleans an unfamiliar request and preserves all literal search criteria", async () => {
    const { read, calls, saved } = mockAssistance({ phrase: compact });
    assert.deepEqual(await read(search), readSearchLocally(search));
    assert.deepEqual(await withAiUsageContext({ searchId: "not-a-scoped-uuid" }, () => read(search)), readSearchLocally(search));
    const result = await withAiUsageContext({ searchId: randomUUID() }, () => read(search));
    assert.equal(result.source, "ai");
    assert.equal(result.cardName, "dark blastoise");
    assert.deepEqual(result.titleWords, ["dark", "blastoise"]);
    assert.deepEqual(result.sets, ["Team Rocket"]);
    assert.deepEqual([result.cardNumber, result.printing, result.finish, result.graded, result.grader, result.minGrade, result.maxGrade],
        ["3", "FIRST_EDITION", "REVERSE_HOLO", true, "CGC", 8, 9.5]);
    assert.equal(marketplaceQuery(search, result), "dark blastoise team rocket #3 reverse holo 1st edition CGC");
    assert.deepEqual(await withAiUsageContext({ searchId: randomUUID() }, () => read(search)), result);
    assert.deepEqual(calls, [search]);
    assert.equal(saved.size, 1);
});

test("assistance cannot swap, invent, remove, or disguise meaningful search terms", async () => {
    for (const phrase of [
        compact.replace("Dark Blastoise", "Blastoise"), compact.replace("Team Rocket", "Base Set"),
        compact.replace("reverse holo", "holo"), compact.replace("1st Edition", "Unlimited"),
        compact.replace("#3", "#3/82"), compact.replace("#3", "3"), compact.replace("CGC", "PSA"),
        compact.replace("Dark", "-Dark"), compact.replace("Dark", "\"Dark\""), compact.replace("Dark", "Dark /"), null,
    ]) {
        const { read, calls } = mockAssistance({ phrase });
        assert.deepEqual(await withAiUsageContext({ searchId: randomUUID() }, () => read(search)), readSearchLocally(search), String(phrase));
        assert.equal(calls.length, 1);
    }
    for (const [typed, phrase] of [["I'm hoping to get a Mewtwo no symbol holo", "Mewtwo holo"],
        ["I'm trying to get Unown A before I buy", "Unown"], ["I'm trying to get Unown !", "Unown"],
        ["I'm trying to get Espeon Shining UnknownVariant", "Espeon Shining"]]) {
        const { read } = mockAssistance({ phrase });
        assert.deepEqual(await withAiUsageContext({ searchId: randomUUID() }, () => read(typed)), readSearchLocally(typed));
    }
});

test("ordinary question punctuation and existing exact marketplace criteria survive cleanup", async () => {
    const { read } = mockAssistance({ phrase: "Unown A Neo Discovery PSA 8+" });
    const typed = "I'm hoping to get a copy of Unown A Neo Discovery PSA 8+?";
    const result = await withAiUsageContext({ searchId: randomUUID() }, () => read(typed));
    assert.equal(result.source, "ai");
    assert.equal(result.cardName, "unown a");
    assert.equal(marketplaceQuery(typed, result), "unown a neo discovery PSA");
});

test("invalid accepted answers and failed assistance fall back without an additional paid request", async () => {
    const { read, calls } = mockAssistance({ phrase: compact, price: 10 });
    await withAiUsageContext({ searchId: randomUUID() }, async () => {
        assert.deepEqual(await read(search), readSearchLocally(search));
        assert.deepEqual(await read(search), readSearchLocally(search));
    });
    assert.equal(calls.length, 1);
    const unavailable = createQueryAssistance({ local, run: async () => { throw new Error("spending guard"); } });
    await withAiUsageContext({ searchId: randomUUID() }, async () => {
        assert.deepEqual(await unavailable(search), readSearchLocally(search));
    });
});

test("legacy accepted intent is reused and cancelled searches start no assistance", async () => {
    const saved = { ...readSearchLocally(compact), source: "ai" as const };
    const read = createQueryAssistance({ local: async () => saved, run: async () => assert.fail("legacy cache should win") });
    await withAiUsageContext({ searchId: randomUUID() }, async () => assert.equal(await read(search), saved));

    const controller = new AbortController();
    const stopped = createQueryAssistance({ local: async text => { controller.abort(); return readSearchLocally(text); },
        run: async () => assert.fail("cancelled searches cannot dispatch") });
    await withAiUsageContext({ searchId: randomUUID() }, () => assert.rejects(stopped(search, controller.signal), { name: "AbortError" }));
});
