import { test } from "node:test";
import assert from "node:assert/strict";
import { screeningSteps } from "../../server/deals/screen-listing.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import type { ScreenInput } from "../../server/deals/prescreen.ts";

test("stopping preliminary screening prevents later raw, grader and paid comp callbacks", async () => {
    const record: CardRecord = { source: "pkmnprices", id: 1, name: "Venusaur", setName: "Base Set", cardNumber: "15/102", tcgPlayerId: null,
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [{ condition: "NEAR_MINT", price: 100, updatedAt: null }] }] };
    const input: ScreenInput = { title: "Venusaur Base Set15/102 Unlimited Holo", aspects: { "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English" },
        price: 30, shipping: 0, isGraded: false, buyingOption: "FIXED_PRICE", cardCondition: "Near mint or better" };
    for (const stage of ["lookup", "raw", "graded"] as const) {
        const stop = new AbortController(); const calls = { lookup: 0, raw: 0, graded: 0, checks: 0 };
        const steps = screeningSteps(undefined, false, stop.signal, {
            lookupCards: async () => { calls.lookup++; if (stage === "lookup") stop.abort(); return [record]; },
            fetchRawComps: async () => { calls.raw++; if (stage === "raw") stop.abort(); return []; },
            fetchComps: async () => { calls.graded++; if (stage === "graded") stop.abort(); return []; },
            checkComps: async () => { calls.checks++; return new Map(); },
        });
        await assert.rejects(steps.check(input), { name: "AbortError" });
        assert.equal(calls.lookup, 1); assert.equal(calls.raw, stage === "lookup" ? 0 : 1);
        assert.equal(calls.graded, stage === "graded" ? 1 : 0); assert.equal(calls.checks, 0);
    }
});
