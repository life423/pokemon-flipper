import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesContinuationDestination, type ContinuationSession } from "../../client/src/search/continuation-session.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { verifiedPurchase } from "../../shared/money/verified-purchase.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("restored advice opens only for the installation's current shipping destination", () => {
    const evaluation = cardEvaluation();
    const stamp = new Date().toISOString();
    evaluation.listing = { ...evaluation.listing, shipping: 0, buyingOption: "FIXED_PRICE", termsCheckedAt: stamp };
    evaluation.pricesCheckedAt = stamp;
    const listing: ListingSummary = { ...evaluation.listing, isGraded: false, images: [], currentPrice: evaluation.listing.price };
    const targets = MONEY_CONFIG.targets;
    const purchase = verifiedPurchase(evaluation, evaluation.underwriting!.best!, targets)!;
    const saved = {
        listings: [listing],
        analyses: { [listing.id]: { status: "done", evaluation, evidenceKey: "offline" } },
        reviews: [[listing.id, { key: "offline", decision: { decision: "BUY", reason: "offline", verifiedPurchase: purchase },
            unavailable: false, attempts: 1 }]],
    } satisfies Pick<ContinuationSession, "listings" | "analyses" | "reviews">;
    const checkpoint = saved as ContinuationSession;

    assert.equal(matchesContinuationDestination(checkpoint, null), true, "legacy evidence with no destination can restore when no ZIP is configured");
    assert.equal(matchesContinuationDestination(checkpoint, "10001"), false);
    listing.shippingDestination = "10001";
    evaluation.listing.shippingDestination = "10001";
    assert.equal(matchesContinuationDestination(checkpoint, "10001"), false, "a restored receipt for a different destination is invalid");
    purchase.shippingDestination = "10001";
    assert.equal(matchesContinuationDestination(checkpoint, "10001"), true);
    assert.equal(matchesContinuationDestination(checkpoint, "90210"), false);
    assert.equal(matchesContinuationDestination({ ...checkpoint, shippingDestination: "10001" }, "90210"), false,
        "new checkpoints bind continuing discovery to the saved destination");
});
