import { test } from "node:test";
import assert from "node:assert/strict";
import { screenListing, shippingCouldChange, type ScreenSteps } from "../../server/deals/find-deals.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import type { ListingSummary, Screen } from "../../shared/types.ts";
const config = { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } };
const dropped = (): Screen => ({ status: "DROPPED", reason: null, card: null, bestCase: null, assumed: null, money: { shipping: 7, auction: false, usual: null, paths: [{ label: "Raw", expectedNet: 25, fixedCosts: 0 }] } });
const listing: ListingSummary = { id: "test", title: "Venusaur Base Set 15/102", currentPrice: 20, shipping: null, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, images: [], seller: null, isGraded: false, url: "" };
test("only quotes that could change eligibility spend a detail request; strict targets remain enforced", () => {
    assert.equal(shippingCouldChange(dropped(), 20, config), true);
    assert.equal(shippingCouldChange(dropped(), 30, config), false);
    assert.equal(shippingCouldChange(dropped(), 20, MONEY_CONFIG), false);
});
for (const quote of [0, 2, 9, null]) test(`borderline unknown shipping requests fresh details and propagates ${quote}; unknown is never free`, async () => {
    let checks = 0, details = 0;
    const steps: ScreenSteps = {
        shippingCouldChange: (screen, price) => shippingCouldChange(screen, price, config),
        readTitle: async () => ({ aspects: { Set: "Base Set" }, filled: [], condition: null, kind: null }),
        loadDetails: async (_id, _listing, fresh) => { details++; assert.equal(fresh, true); return { ...listing, price: listing.currentPrice, condition: "Ungraded", aspects: {}, shipping: quote, cardCondition: null, conditionNotes: [] }; },
        check: async input => { checks++; if (checks === 1) return dropped(); assert.equal(input.shipping, quote); return { ...dropped(), status: quote !== null && quote <= 2 ? "CANDIDATE" : "DROPPED" }; },
        matchPhoto: async () => null,
    };
    const result = await screenListing(listing, steps);
    assert.equal(details, 1); assert.equal(result.shipping, quote);
    assert.equal(result.screen?.status, quote !== null && quote <= 2 ? "CANDIDATE" : "DROPPED");
});
test("known shipping, failed quotes and cancellation preserve the original screening", async () => {
    let calls = 0;
    const steps: ScreenSteps = { readTitle: async () => ({ aspects: {}, filled: [], condition: null, kind: null }), check: async () => dropped(), shippingCouldChange: () => true, loadDetails: async () => { calls++; throw Error("unavailable"); }, matchPhoto: async () => null };
    assert.equal((await screenListing({ ...listing, shipping: 5 }, steps)).screen?.status, "DROPPED");
    assert.equal(calls, 0);
    assert.equal((await screenListing(listing, steps)).screen?.status, "DROPPED"); assert.equal(calls, 1);
    const controller = new AbortController();
    steps.loadDetails = async () => { controller.abort(); throw Error("cancelled"); };
    await assert.rejects(screenListing(listing, steps, null, controller.signal), { name: "AbortError" });
});
