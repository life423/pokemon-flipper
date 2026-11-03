import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { fetchComps, fetchRawComps } from "../../server/pricing/pkmnprices.ts";

test("sold adapters bound pages, request recent sales and exclude non-USD rows before money math", async (t) => {
    const original = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-test-key";
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        return Response.json({ data: [{ id: 1, currency: "USD", price: 100 }, { id: 2, currency: "EUR", price: 10 }], pagination: { has_more: true, next_cursor: "next-page", total_pages: 1 } });
    });
    const id = `offline-${Date.now()}-${Math.random()}`;
    try {
        const graded = await fetchComps(id, { grader: "PSA", grade: 8, variant: "Unlimited Holofoil" });
        assert.equal(graded.length, 1, "duplicate rows across graded pages are counted once"); assert.equal(graded[0].currency, "USD");
        assert.equal(calls[0].searchParams.get("period"), "180d");
        const raw = await fetchRawComps(id, "Unlimited Holofoil");
        assert.equal(raw.length, 2, "only two bounded pages even if the provider has more");
        assert.equal(calls.length, 4);
        assert.equal(calls[1].searchParams.get("cursor"), "next-page");
        assert.equal(calls[2].searchParams.get("period"), "90d");
        assert.equal(calls[3].searchParams.get("cursor"), "next-page");
    } finally { if (original === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = original; }
});
