import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedSoldCondition, corroboratedSoldCondition, type SoldConditionReading } from "../../server/ai/sold-condition.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
const identity = cardEvaluation().identity!;
function reading(): SoldConditionReading {
    return { card: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Visible name, collector number and Base Set artwork agree"] }, printing: "UNLIMITED", condition: "LIGHTLY_PLAYED", confidence: "HIGH", oneRawCard: true, frontVisible: true, backVisible: true, closeUps: true, structuralDamage: false, evidence: ["Minor corner whitening on both sides"], limitations: [] };
}
test("sold-copy classification requires actual identity, printing and visible condition; structural damage outranks a mint guess", () => {
    const input = reading(); assert.equal(acceptedSoldCondition(input, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(acceptedSoldCondition({ ...input, backVisible: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, oneRawCard: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, printing: "FIRST_EDITION" }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", closeUps: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", structuralDamage: true, backVisible: false }, identity, 4)?.condition, "DAMAGED");
});
test("two medium readings may settle wear but cannot vote away missing views, damage or a Mint evidence gap", () => {
    const a = { ...reading(), confidence: "MEDIUM" };
    assert.equal(corroboratedSoldCondition(a, a, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(corroboratedSoldCondition(a, { ...a, condition: "NEAR_MINT" }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, backVisible: false }, a, identity, 4), null);
    assert.equal(corroboratedSoldCondition(a, { ...a, structuralDamage: true }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, condition: "MINT" }, { ...a, condition: "MINT" }, identity, 4), null);
});
