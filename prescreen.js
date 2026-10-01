import { identifyCard, printingClaimFromText, readyForPricing } from "./card-identity.js";
import { rawPricesFor } from "./pricing.js";
import { gradedPricesFor, compsForGrade } from "./graded-comps.js";
import { graderCode, normalizeGrade } from "./slab-check.js";
import { GRADERS, underwrite } from "./underwriting.js";
import { MONEY_CONFIG } from "./money.config.js";

// The free first check, before any paid AI: what a listing is worth at
// its best, from the seller's own details and the price data. A listing
// that can't clear your targets even then is dropped. One that can is
// only a candidate: the AI's look at the photos decides.

// Printing marks that agree with the seller, standing in for photos.
// Sellers name the pricier printings, so with no claim it's Unlimited.
const SELLER_MARKS = {
    FIRST_EDITION: { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" },
    SHADOWLESS: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" },
    UNLIMITED: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
};

const SELLER_CONDITIONS = [
    [/damaged/, "DAMAGED"],
    [/heavily played|\bpoor\b/, "HEAVILY_PLAYED"],
    [/moderately played|very good/, "MODERATELY_PLAYED"],
    [/lightly played|excellent/, "LIGHTLY_PLAYED"],
    [/near mint|\bmint\b/, "NEAR_MINT"],
];

const CONDITION_NAMES = {
    NEAR_MINT: "Near Mint",
    LIGHTLY_PLAYED: "Lightly Played",
    MODERATELY_PLAYED: "Moderately Played",
    HEAVILY_PLAYED: "Heavily Played",
    DAMAGED: "Damaged",
};

// "4/102" in a title, for listings whose item details skip the number.
const TITLE_NUMBER = /\b(\d{1,3}\s*\/\s*\d{1,3})\b/;

// "PSA 8" or "CGC 9.5" in a title.
const TITLE_GRADE = /\b(psa|cgc|bgs|sgc|tag)\s*(10|[1-9](?:\.5)?)\b/i;

// eBay's card condition for a raw card ("Near mint or better",
// "Lightly played (Excellent)"), as a price condition. With none,
// assume the best.
export function sellerCondition(text) {
    const value = String(text ?? "").toLowerCase();
    const found = SELLER_CONDITIONS.find(([pattern]) => pattern.test(value));

    return found ? found[1] : "NEAR_MINT";
}

function sellerPrinting(listing) {
    const specifics = Object.entries(listing.aspects ?? {})
        .filter(([name]) => /edition|feature|print/i.test(name))
        .map(([, value]) => value)
        .join(" ");

    const claims = [printingClaimFromText(listing.title), printingClaimFromText(specifics)].filter(
        (claim) => claim !== "NOT_STATED"
    );

    return claims[0] ?? "UNLIMITED";
}

function screen(status, reason, extra = {}) {
    return { status, reason, card: null, bestCase: null, assumed: null, ...extra };
}

// Screens one listing: price, shipping, isGraded, title, aspects, and
// cardCondition. lookupCards and fetchComps are passed in so tests can
// supply their own.
export async function prescreen(listing, { lookupCards, fetchComps, config = MONEY_CONFIG, now = Date.now() }) {
    if (typeof listing.price !== "number") {
        return screen("UNSCREENED", "The listing has no price.");
    }

    const aspects = listing.aspects ?? {};

    // The identity code, run on the seller's word instead of photos.
    const sellerView = {
        printingMarks: SELLER_MARKS[sellerPrinting(listing)],
        printedName: null,
        printedNumber: aspects["Card Number"] ? null : (listing.title.match(TITLE_NUMBER)?.[1].replace(/\s/g, "") ?? null),
        slab: null,
    };

    let identified;

    try {
        identified = await identifyCard(listing, sellerView, { lookupCards });
    } catch (error) {
        return screen("UNSCREENED", `The card lookup failed: ${error.message}`);
    }

    const { identity, card } = identified;

    if (!readyForPricing(identity)) {
        return screen("UNSCREENED", identity.reasons[0] ?? "The card couldn't be identified from the listing.");
    }

    const cardInfo = {
        name: identity.name,
        set: identity.set,
        cardNumber: identity.cardNumber,
        printingLabel: identity.printingLabel,
    };

    const evaluation = {
        listing: { price: listing.price, shipping: listing.shipping },
        identity,
        slab: null,
        condition: null,
    };

    let assumed;
    let outcome;

    try {
        if (listing.isGraded) {
            const fromTitle = listing.title.match(TITLE_GRADE);
            const grader = graderCode(aspects["Professional Grader"]) ?? (fromTitle ? graderCode(fromTitle[1]) : null);
            const grade = normalizeGrade(aspects.Grade) ?? (fromTitle ? fromTitle[2] : null);

            if (!grader || !grade) {
                return screen("UNSCREENED", "The listing doesn't give the grader and grade.", { card: cardInfo });
            }

            if (!GRADERS.includes(grader)) {
                return screen("UNSCREENED", `Only PSA and CGC slabs are priced so far, not ${grader}.`, { card: cardInfo });
            }

            evaluation.slab = { status: "OK", grader, grade, reasons: [], concerns: [] };
            evaluation.slabPricing = await compsForGrade(card, identity, { grader, grade, fetchComps, now });
            outcome = underwrite(evaluation, config);
            assumed = `${grader} ${grade}, as listed`;
        } else {
            // At its best: the seller's own condition call, and the grade a
            // card in that condition could reach at best.
            const rawCondition = sellerCondition(listing.cardCondition);
            const grade = config.prescreen.bestGrade[rawCondition];
            const gradeRange = { low: grade, likely: grade, high: grade };

            evaluation.condition = {
                rawCondition,
                gradeRange,
                authenticity: { concern: "NONE_SEEN", reasons: [] },
            };
            evaluation.rawPricing = rawPricesFor(card, identity);
            evaluation.gradedPricing = {};
            outcome = underwrite(evaluation, config);

            // pkmnprices charges per sale returned, so sold comps are
            // fetched only while nothing clears yet.
            for (const grader of GRADERS) {
                if (outcome.verdict.startsWith("BUY")) break;

                evaluation.gradedPricing[grader] = await gradedPricesFor(card, identity, gradeRange, {
                    fetchComps,
                    grader,
                    now,
                });
                outcome = underwrite(evaluation, config);
            }

            assumed = `${CONDITION_NAMES[rawCondition]}, grading ${grade} at best`;
        }
    } catch (error) {
        return screen("UNSCREENED", `The price lookup failed: ${error.message}`, { card: cardInfo });
    }

    const { verdict, reasons, best } = outcome;
    const bestCase = best ? { label: best.label, maxBid: best.maxBid, profit: best.profit, roi: best.roi } : null;

    if (verdict.startsWith("BUY")) {
        return screen("CANDIDATE", null, { card: cardInfo, bestCase, assumed });
    }

    if (verdict === "PASS") {
        return screen("DROPPED", reasons[0] ?? null, { card: cardInfo, bestCase, assumed });
    }

    return screen("UNSCREENED", reasons[0] ?? "It couldn't be priced.", { card: cardInfo, assumed });
}
