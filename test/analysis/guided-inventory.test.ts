import test from "node:test";
import assert from "node:assert/strict";
import { guidedInventoryTargets } from "../../server/analysis/guided-inventory.ts";

test("exclusive or numbered guidance stops after the submitted card and makes no catalog requests", async () => {
    for (const seed of [{ name: "Ampharos", number: null, expand: false }, { name: "Ampharos", number: "H1/H32", expand: true }]) {
        const seen = [];
        for await (const target of guidedInventoryTargets(seed, [], "all", Date.now(), new AbortController().signal,
            () => true, async () => assert.fail("exclusive scope cannot broaden"))) seen.push(target);
        assert.deepEqual(seen.map(t => [t.name, t.number, t.set]), [[seed.name, seed.number, null]]);
    }
});

test("flexible guidance widens lazily from Ampharos to a verified set, then to ranked vintage cards", async () => {
    const seed = { name: "Ampharos", number: null, expand: true };
    let calls = 0;
    const gen = guidedInventoryTargets(seed, [], "raw", Date.now(), new AbortController().signal, () => true,
        async query => {
            calls++;
            const species = query.get("name");
            return {data: species ? [{id:1,name:"Ampharos",number:"1",total_set_number:"147",set:{name:"Aquapolis"}}] :
                [{id:2,name:"Gengar",number:"5",total_set_number:"62",set:{name:"Fossil"}}]};
        }, async (cards, kind) => {
            assert.equal(kind, "raw");
            assert.deepEqual(Array.from(cards).map(c=>c.name), ["Gengar"]);
            return [{id:2,name:"Gengar",number:"5/62",set:"Fossil",sales:12}];
        });
    assert.equal((await gen.next()).value?.name, "Ampharos"); assert.equal(calls, 0);
    assert.equal((await gen.next()).value?.set, "Aquapolis"); assert.equal(calls, 1);
    assert.equal((await gen.next()).value?.name, "Gengar");
    assert.equal((await gen.next()).done, true);
});

test("explicit set guidance stays inside the submitted releases", async () => {
    const seed = { name: "Ampharos", number: null, expand: true };
    const stages = [];
    for await (const t of guidedInventoryTargets(seed, ["Aquapolis"], "all", Date.now(), new AbortController().signal,
        set => set === "Aquapolis", async () => assert.fail("a named set is already resolved"))) stages.push([t.name,t.set]);
    assert.deepEqual(stages, [["Ampharos","Aquapolis"],[null,"Aquapolis"]]);
});
