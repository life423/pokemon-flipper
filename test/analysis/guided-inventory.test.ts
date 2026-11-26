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

test("flexible guidance widens lazily to the confirmed set and nearby releases only", async () => {
    const seed = { name: "Ampharos", number: null, expand: true };
    let calls = 0;
    const gen = guidedInventoryTargets(seed, [], "raw", Date.now(), new AbortController().signal, () => true,
        async query => {
            calls++;
            const species = query.get("name");
            return {data: species ? [{id:1,name:"Ampharos",number:"1",total_set_number:"147",set:{name:"Aquapolis"}}] :
                [{id:2,name:"Gengar",number:"5",total_set_number:"62",set:{name:"Fossil"}}]};
        }, undefined, { years: async () => ({ aquapolis: 2003, skyridge: 2003, modern: 2025 }) });
    assert.equal((await gen.next()).value?.name, "Ampharos"); assert.equal(calls, 0);
    assert.equal((await gen.next()).value?.set, "Aquapolis"); assert.equal(calls, 1);
    assert.equal((await gen.next()).value?.set, "skyridge");
    assert.equal((await gen.next()).done, true);
});

test("a web suggestion needs a permitted release and an exact catalog fraction before it becomes a query", async () => {
    const signal = new AbortController().signal;
    const seed = { name: "Ampharos", expand: true, number: null };
    const notes: string[] = [], names: string[] = [];
    for await (const t of guidedInventoryTargets(seed, ["Aquapolis"], "raw", Date.now(), signal, () => true,
        async params => {
            names.push(params.get("name")!);
            return { data: [{id: 2, name: "Espeon", set: {name: "Aquapolis"}, number: "11", total_set_number: "147"}] };
        }, async () => [], {
            chooseWeb: async releases => { assert.deepEqual(releases, ["Aquapolis"]); return true; },
            report: note => notes.push(note),
            web: async () => [
                {name:"Espeon", set:"Aquapolis", number:"11/147", url:"https://www.pokemon.com/checked"},
                {name:"Espeon", set:"Aquapolis", number:"11/999", url:"https://www.pokemon.com/wrong"},
                {name:"Espeon", set:"Aquapolis", number:"11", url:"https://www.pokemon.com/partial"},
                {name:"Modern reprint", set:"2025 release", number:"11/147", url:"https://www.pokemon.com/modern"},
            ],
        })) if (t.stage === "Catalog-checked web lead") assert.deepEqual([t.name, t.number, t.set], ["Espeon","11/147","Aquapolis"]);
    assert.deepEqual(names, ["Espeon", "Espeon"]);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Espeon 11\/147.*pokemon\.com\/checked/);
});

test("a name shared by vintage and modern printings needs a release before suggesting other cards", async () => {
    const releases = ["Aquapolis", "Modern reprint"];
    for (const observed of [null, "Aquapolis"]) {
        const stages = [];
        for await (const t of guidedInventoryTargets({ name:"Ampharos", number:null, expand:true }, [], "all", Date.now(),
            new AbortController().signal, () => true, async () => ({data: releases.map((name, i) => ({id:i+1, name:"Ampharos", set:{name}}))}),
            undefined, { years: async () => ({aquapolis:2003, skyridge:2003, "modern reprint":2025}), observedSet: () => observed }))
            stages.push(t.set);
        assert.deepEqual(stages, observed ? [null,"Aquapolis","skyridge"] : [null]);
    }
});

test("explicit set guidance stays inside the submitted releases", async () => {
    const seed = { name: "Ampharos", number: null, expand: true };
    const stages = [];
    for await (const t of guidedInventoryTargets(seed, ["Aquapolis"], "all", Date.now(), new AbortController().signal,
        set => set === "Aquapolis", async () => assert.fail("a named set is already resolved"))) stages.push([t.name,t.set]);
    assert.deepEqual(stages, [["Ampharos","Aquapolis"],[null,"Aquapolis"]]);
});
