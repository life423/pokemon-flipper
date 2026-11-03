import { test } from "node:test";
import assert from "node:assert/strict";
import { rawConditionClaim, sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { compCondition } from "../../server/pricing/raw-comps.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";

test("explicit collector numbers and years do not consume the heavily-played condition", () => {
    for (const title of ["Venusaur 15/102 HP Holo", "Houndoom H11/H32 HP", "Charizard #123 HP", "Charizard # 120 HP", "Venusaur 1999 HP", "Venusaur 1999 HP Holo", "Venusaur 15 / 102 HP", "Venusaur 15/102 hp 1999", "HP120 Venusaur 15/102 HP", "Venusaur HP 15/102", "Venusaur HP15/102", "Charizard HP #123", "Charizard HP#123"]) {
        assert.equal(rawConditionClaim(title), "HEAVILY_PLAYED", title);
        assert.equal(compCondition(title), "HEAVILY_PLAYED", title);
        assert.equal(readTitleByRules(title).condition, "Heavily Played", title);
    }
});

test("actual hit-point labels are ignored before reading a separate raw condition", () => {
    for (const title of ["Charizard 120 HP", "Charizard 120HP", "Charizard HP120", "Charizard HP 120", "Something 100 HP", "Venusaur 15/102 100 HP", "Charizard H11/H32 120 HP"]) {
        assert.equal(rawConditionClaim(title), null, title);
        assert.equal(compCondition(title), null, title);
        assert.equal(readTitleByRules(title).condition, null, title);
    }
    for (const title of ["Something 100 HP NM", "Something HP100 NM", "Venusaur 15/102 100HP NM"]) {
        assert.equal(rawConditionClaim(title), "NEAR_MINT", title);
        assert.equal(readTitleByRules(title).condition, "Near Mint", title);
    }
    assert.equal(rawConditionClaim("Venusaur Heavily Played 100 HP"), "HEAVILY_PLAYED");
    assert.equal(rawConditionClaim("Venusaur 100 HP LP"), "LIGHTLY_PLAYED");
});

test("ambiguous and questioned seller conditions remain unknown, including after collector numbers", () => {
    for (const title of ["Venusaur NM/LP", "Venusaur LP-NM", "Venusaur NM?", "Venusaur mint?", "Venusaur LP ?", "Venusaur Near Mint?", "Venusaur Lightly Played?", "Venusaur 15/102 HP?", "Venusaur 15/102 HP NM", "Venusaur mint NM", "Venusaur 100HP LP NM"]) {
        assert.equal(rawConditionClaim(title), null, title);
        assert.equal(readTitleByRules(title).condition, null, title);
    }
});

test("typed conditions preserve sold-parser vocabulary and the title reader's historical display vocabulary", () => {
    const cases = [["MINT", "MINT", "Near Mint"], ["Near-Mint", "NEAR_MINT", "Near Mint"], ["NM", "NEAR_MINT", "Near Mint"],
        ["Lightly-Played", "LIGHTLY_PLAYED", "Lightly Played"], ["MP", "MODERATELY_PLAYED", "Moderately Played"],
        ["Heavily Played", "HEAVILY_PLAYED", "Heavily Played"], ["DMG", "DAMAGED", "Damaged"]] as const;
    for (const [words, typed, display] of cases) {
        assert.equal(rawConditionClaim(`Venusaur ${words}`), typed);
        assert.equal(compCondition(`Venusaur ${words}`), typed);
        assert.equal(readTitleByRules(`Venusaur ${words}`).condition, display);
    }
    assert.equal(rawConditionClaim("Venusaur Excellent"), null, "do not silently expand sold-title condition semantics");
    assert.equal(readTitleByRules("Venusaur Excellent").condition, "Lightly Played");
    assert.equal(readTitleByRules("Venusaur Excellent 120HP").condition, "Lightly Played");
    assert.equal(readTitleByRules("Venusaur Excellent NM").condition, null);
    assert.equal(readTitleByRules("Venusaur Excellent?").condition, null);
    assert.equal(rawConditionClaim("Venusaur holo"), null);
});

test("condition parsing does not modify literal card identity or collector numbers", () => {
    const reading = readTitleByRules("Venusaur Base Set 15/102 HP Holo English");
    assert.equal(reading.cardName, "venusaur");
    assert.equal(reading.cardNumber, "15/102");
    assert.equal(reading.set, "Base Set");
    assert.equal(reading.language, "English");
});

test("listing-only condition clues reconcile title, saved item condition and explicit card notes without inventing a condition", () => {
    const agree = sellerConditionClues({ title: "Venusaur NM", cardCondition: "Near mint or better", conditionNotes: ["The card is near mint."] });
    assert.deepEqual(agree, { claim: "NEAR_MINT", conflict: false, ambiguous: false, severe: false });
    for (const cardCondition of ["HEAVILY_PLAYED", "Heavily played (Poor)", "Poor", "Damaged"]) {
        const clues = sellerConditionClues({ title: "Venusaur NM", cardCondition });
        assert.equal(clues.claim, null); assert.equal(clues.conflict, true); assert.equal(clues.severe, true);
    }
    assert.deepEqual(sellerConditionClues({ title: "Venusaur LP", cardCondition: "Near Mint" }),
        { claim: null, conflict: true, ambiguous: true, severe: false });
    assert.equal(sellerConditionClues({ title: "Venusaur", cardCondition: "Lightly played (Excellent)" }).claim, "LIGHTLY_PLAYED");
    assert.equal(sellerConditionClues({ title: "Venusaur", cardCondition: "Very good" }).claim, "MODERATELY_PLAYED");
    assert.equal(sellerConditionClues({ title: "Venusaur Mint", cardCondition: "Mint" }).claim, "MINT", "still only seller words, not a verified Mint assessment");
    assert.deepEqual(sellerConditionClues({ title: "Venusaur 120 HP", cardCondition: null, conditionNotes: [] }),
        { claim: null, conflict: false, ambiguous: false, severe: false });
});

test("ambiguous claims remain unknown while a separate explicit HP or damage statement supplies caution", () => {
    for (const title of ["Venusaur NM/LP", "Venusaur NM?", "Venusaur mint?"]) assert.equal(sellerConditionClues({ title }).claim, null);
    for (const conditionNotes of [["The card is damaged."], ["Card is heavily played."], ["NM? HP"], ["NM/HP"]]) {
        const clues = sellerConditionClues({ title: "Venusaur Near Mint", conditionNotes });
        assert.equal(clues.claim, null); assert.equal(clues.severe, true);
    }
    for (const title of ["Venusaur 15/102 HP", "Venusaur HP15/102", "Venusaur #123 HP", "Venusaur HP #123", "Venusaur 1999 HP"])
        assert.equal(sellerConditionClues({ title }).severe, true, title);
    for (const title of ["Venusaur 120 HP NM", "Venusaur HP120 NM", "Venusaur HP 120 NM"])
        assert.equal(sellerConditionClues({ title }).severe, false, title);
});

test("holder wear and negated condition words do not become claims about card damage", () => {
    for (const conditionNotes of [["The sleeve is damaged."], ["Holder damaged; the card is near mint."],
        ["The card is near mint but the case is damaged."], ["Near mint card in a damaged sleeve."],
        ["Card near mint and holder is damaged."], ["Not damaged. No heavily played card."]]) {
        const clues = sellerConditionClues({ title: "Venusaur NM", conditionNotes });
        assert.equal(clues.severe, false, conditionNotes.join(" ")); assert.equal(clues.conflict, false, conditionNotes.join(" "));
        assert.equal(clues.claim, "NEAR_MINT");
    }
    assert.equal(sellerConditionClues({ title: "Venusaur HP in sleeve" }).severe, true, "a sleeve in the title must not erase an explicit card condition");
    assert.equal(sellerConditionClues({ title: "Venusaur", conditionNotes: ["Damaged card in sleeve."] }).severe, true);
    assert.equal(sellerConditionClues({ title: "Venusaur NM damaged case" }).severe, false);
    assert.equal(sellerConditionClues({ title: "Venusaur not NM/LP" }).claim, null);
});
