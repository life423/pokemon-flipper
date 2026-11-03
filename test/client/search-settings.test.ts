import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ALL, AUTO_KEY, DEFAULT_AUTO, DEFAULT_RESULTS, readAutoSetting, readResultsSetting } from "../../client/src/search/settings.ts";
import { BOUNDED_AUTO_CONCURRENCY, DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";

function storage(t: TestContext, entries: Record<string, string> = {}) {
    const saved = new Map(Object.entries(entries));
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => { saved.set(key, value); },
    } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
    return saved;
}

test("fresh settings display50 metadata results independently of budgeted automatic assessment", t => {
    storage(t);
    assert.equal(DEVELOPMENT_SEARCH_LIMIT, 50);
    assert.equal(DEFAULT_RESULTS, 50);
    assert.equal(readResultsSetting(), 50);
    assert.equal(DEFAULT_AUTO, ALL);
    assert.equal(readAutoSetting(), ALL);
    assert.ok(BOUNDED_AUTO_CONCURRENCY < DEVELOPMENT_SEARCH_LIMIT, "metadata count must not start50 simultaneous detail/photo workflows");
});

test("old3and25 result limits migrate to50 without turning manual-only AI back on", t => {
    const saved = storage(t, { results: "3", [AUTO_KEY]: "0" });
    assert.equal(readResultsSetting(), 50);
    assert.equal(saved.get("results"), "50");
    assert.equal(readAutoSetting(), 0);
    assert.equal(saved.get(AUTO_KEY), "0");
    saved.set("results", "25");
    assert.equal(readResultsSetting(), 50);
    assert.equal(saved.get("results"), "50");
});

test("old numeric AI defaults migrate to automatic budgeted work rather than promising that many paid assessments", t => {
    const saved = storage(t, { [AUTO_KEY]: "3" });
    assert.equal(readAutoSetting(), ALL);
    assert.equal(saved.get(AUTO_KEY), String(ALL));
    saved.set(AUTO_KEY, "25");
    assert.equal(readAutoSetting(), ALL);
    assert.equal(saved.get(AUTO_KEY), String(ALL));
});
