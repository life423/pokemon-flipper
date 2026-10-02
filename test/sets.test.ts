import { test } from "node:test";
import assert from "node:assert/strict";
import { setKey, yearOf } from "../shared/sets.ts";

test("set names from either price source reach the same key", () => {
    assert.equal(setKey("SWSH09: Brilliant Stars"), setKey("Brilliant Stars"));
    assert.equal(setKey("Base Set (Shadowless)"), "base set");
    assert.equal(setKey("Pokémon GO"), "go");
    assert.notEqual(setKey("Base Set 2"), setKey("Base Set"));
});

test("a card's set finds its release year, or none", () => {
    const years = { "base set": 1999, "neo genesis": 2000 };

    assert.equal(yearOf(years, "Base Set"), 1999);
    assert.equal(yearOf(years, "Neo Genesis"), 2000);
    assert.equal(yearOf(years, "Gym Heroes"), null);
    assert.equal(yearOf(years, null), null);
});
