import { readyForPricing } from "../identity/card-identity.js";
import { MONEY_CONFIG } from "../config/money.js";

// The money math. Pure code, no AI: every number comes from the
// evaluation and money.config.js, so the same inputs always give the
// same verdict.

// Graders whose sold comps price the grading path.
export const GRADERS = ["PSA", "CGC"];

const CONDITION_ORDER = [
    "NEAR_MINT",
    "LIGHTLY_PLAYED",
    "MODERATELY_PLAYED",
    "HEAVILY_PLAYED",
    "DAMAGED",
];

const round2 = (value) => Math.round(value * 100) / 100;

function dollars(value) {
    return value < 0 ? `-$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`;
}

// eBay's fee on one sale: a percentage of everything the buyer pays
// (their sales tax included), tiered above the limit, plus the per-order
// fee and any Promoted Listings rate.
export function ebaySellingFees(salePrice, selling) {
    const base = salePrice * (1 + selling.typicalBuyerTaxRate);
    const upToLimit = Math.min(base, selling.finalValueTierLimit);
    const aboveLimit = Math.max(0, base - selling.finalValueTierLimit);
    const perOrder = base <= selling.smallOrderLimit ? selling.perOrderFeeSmall : selling.perOrderFee;

    return round2(
        upToLimit * selling.finalValueRate +
            aboveLimit * selling.finalValueRateAboveLimit +
            perOrder +
            salePrice * selling.promotedRate
    );
}

// What you keep from a sale after eBay's fees and shipping it out.
export function netFromSale(salePrice, kind, selling) {
    return round2(salePrice - ebaySellingFees(salePrice, selling) - selling.shipping[kind]);
}

// What a purchase costs: price plus shipping, plus sales tax on both.
export function acquisitionCost(price, shipping, buying) {
    return round2((price + shipping) * (1 + buying.salesTaxRate));
}

// The cheapest service level whose cap covers the card's value.
export function gradingTier(grader, declaredValue, grading) {
    const allowed = (grading[grader] ?? []).filter(
        (tier) => tier.maxDeclaredValue !== null && declaredValue <= tier.maxDeclaredValue
    );

    if (allowed.length === 0) return null;

    const cost = (tier) => tier.fee + (tier.percentOfValue ?? 0) * declaredValue;
    const best = allowed.reduce((a, b) => (cost(b) < cost(a) ? b : a));

    return { grader, tier: best.tier, fee: round2(cost(best)) };
}

// The grade range as probabilities, decided in code: the likely grade
// counts most and each step away counts less. With no likely grade
// (limited evidence), every grade in the range is equally likely.
export function gradeProbabilities({ low, likely, high }) {
    const grades = [];

    for (let grade = low; grade <= high; grade += 1) grades.push(grade);

    const weights = grades.map((grade) => (likely === null ? 1 : 1 / (1 + Math.abs(grade - likely))));
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    return grades.map((grade, index) => ({ grade, probability: weights[index] / total }));
}

// The median sold price for each grade in the range. A grade with no
// verified sales takes the price of the nearest lower grade that has
// some, never a higher one. With nothing below it, there's no floor.
export function pricesByGrade(byGrade, { low, high }) {
    const known = new Map(
        byGrade
            .filter((summary) => summary.count > 0 && typeof summary.median === "number")
            .map((summary) => [summary.grade, summary.median])
    );

    const prices = {};
    let floor = null;

    for (let grade = low; grade <= high; grade += 1) {
        if (known.has(grade)) {
            floor = { grade, price: known.get(grade) };
            prices[grade] = { price: floor.price, filledFrom: null };
        } else if (floor) {
            prices[grade] = { price: floor.price, filledFrom: floor.grade };
        } else {
            return {
                ok: false,
                reason: `No verified sales at grade ${grade}, the low end of the range, so there's no floor to price from.`,
            };
        }
    }

    return { ok: true, prices };
}

// The most you can pay and still clear both targets: the minimum
// profit and the minimum return.
export function maxBid({ expectedNet, fixedCosts, shipping }, config) {
    const { minProfit, minRoi } = config.targets;
    const costCap = Math.min(expectedNet - minProfit, expectedNet / (1 + minRoi));
    const bid = (costCap - fixedCosts) / (1 + config.buying.salesTaxRate) - shipping;

    return bid > 0 ? Math.floor(bid) : 0;
}

function unavailablePath(path, label, reason, extra = {}) {
    return { path, label, status: "UNAVAILABLE", reason, ...extra };
}

function pricedPath({ path, label, expectedNet, downsideNet, fixedCosts, listing, shipping, config, extra }) {
    const cost = round2(acquisitionCost(listing.price, shipping, config.buying) + fixedCosts);
    const profit = round2(expectedNet - cost);
    const limit = maxBid({ expectedNet, fixedCosts, shipping }, config);

    return {
        path,
        label,
        status: "PRICED",
        expectedNet: round2(expectedNet),
        cost,
        profit,
        roi: cost > 0 ? round2(profit / cost) : null,
        downside: round2(downsideNet - cost),
        maxBid: limit,
        clears: limit > 0 && listing.price <= limit,
        ...extra,
    };
}

// Path 1: buy raw, resell raw at the assessed condition's price.
export function rawPath(evaluation, shipping, config) {
    const label = "Resell raw";
    const { rawPricing, condition, listing } = evaluation;

    if (rawPricing?.status !== "PRICED") {
        return unavailablePath("RAW", label, rawPricing?.reason ?? "There's no raw price.");
    }

    const start = CONDITION_ORDER.indexOf(condition.rawCondition);

    if (start === -1) {
        return unavailablePath("RAW", label, "The photos don't support a raw condition, so the raw price is unknown.");
    }

    // The assessed condition's price, or the nearest worse condition's.
    // Never a better one.
    const entry = CONDITION_ORDER.slice(start)
        .map((name) => rawPricing.prices.find((price) => price.condition === name))
        .find(Boolean);

    if (!entry) {
        return unavailablePath("RAW", label, "There's no raw price at the assessed condition or below.");
    }

    const net = netFromSale(entry.price, "raw", config.selling);

    return pricedPath({
        path: "RAW",
        label,
        expectedNet: net,
        downsideNet: net,
        fixedCosts: 0,
        listing,
        shipping,
        config,
        extra: {
            salePrice: entry.price,
            priceCondition: entry.condition,
            assessedCondition: condition.rawCondition,
        },
    });
}

// Path 2: buy raw, grade with one grader, resell. Priced across the
// whole grade range, with that grader's own sold comps.
export function gradePath(evaluation, grader, shipping, config) {
    const label = `Grade with ${grader}`;
    const graded = evaluation.gradedPricing?.[grader];

    if (graded?.status !== "PRICED") {
        return unavailablePath("GRADE", label, graded?.reason ?? `There are no ${grader} sales to price with.`, { grader });
    }

    const { gradeRange } = evaluation.condition;
    const byGrade = pricesByGrade(graded.byGrade, gradeRange);

    if (!byGrade.ok) {
        return unavailablePath("GRADE", label, byGrade.reason, { grader });
    }

    const outlook = gradeProbabilities(gradeRange).map(({ grade, probability }) => {
        const { price, filledFrom } = byGrade.prices[grade];
        return { grade, probability, price, filledFrom, net: netFromSale(price, "graded", config.selling) };
    });

    // Tiers are chosen by the value at the top of the range, so a good
    // grade can't trigger a surprise upcharge.
    const declaredValue = byGrade.prices[gradeRange.high].price;
    const tier = gradingTier(grader, declaredValue, config.grading);

    if (!tier) {
        return unavailablePath(
            "GRADE",
            label,
            `No ${grader} service level in money.config.js covers a card worth ${dollars(declaredValue)}.`,
            { grader }
        );
    }

    return pricedPath({
        path: "GRADE",
        label,
        expectedNet: outlook.reduce((sum, o) => sum + o.probability * o.net, 0),
        downsideNet: outlook[0].net,
        fixedCosts: tier.fee + config.grading.shippingPerCard,
        listing: evaluation.listing,
        shipping,
        config,
        extra: {
            grader,
            tier: tier.tier,
            gradingFee: tier.fee,
            expectedSale: round2(outlook.reduce((sum, o) => sum + o.probability * o.price, 0)),
            outlook,
        },
    });
}

// Path 3: buy a graded card and resell it as is. Waiting on graded
// listing support; priced from sold comps for the exact grader, grade,
// and printing.
export function gradedResalePath(listing, compsSummary, shipping, config) {
    const label = `Resell as ${compsSummary.grader} ${compsSummary.grade}`;

    if (!(compsSummary.count > 0)) {
        return unavailablePath("GRADED_RESALE", label, `No verified ${compsSummary.grader} ${compsSummary.grade} sales.`);
    }

    return pricedPath({
        path: "GRADED_RESALE",
        label,
        expectedNet: netFromSale(compsSummary.median, "graded", config.selling),
        downsideNet: netFromSale(compsSummary.low, "graded", config.selling),
        fixedCosts: 0,
        listing,
        shipping,
        config,
        extra: { salePrice: compsSummary.median },
    });
}

function verdict(name, reasons, extra = {}) {
    return { verdict: name, reasons, best: null, paths: [], assumptions: [], ...extra };
}

// Path 3: a graded card, resold as is.
function underwriteSlab(evaluation, shipping, config, assumptions) {
    const { slab, slabPricing, listing } = evaluation;

    if (slab.status === "LIKELY_FAKE") {
        return verdict("PASS", ["The slab or label looks fake.", ...slab.concerns]);
    }
    if (slab.status !== "OK") {
        return verdict("NEEDS_REVIEW", slab.reasons);
    }
    if (slabPricing?.status !== "PRICED") {
        return verdict(
            "CANT_PRICE",
            [slabPricing?.reason ?? `There are no ${slab.grader} ${slab.grade} sales to price with.`],
            { assumptions }
        );
    }

    const path = gradedResalePath(listing, slabPricing.summary, shipping, config);

    if (path.clears) {
        return { verdict: "BUY_GRADED", reasons: [], best: path, paths: [path], assumptions };
    }

    return {
        verdict: "PASS",
        reasons: [
            path.maxBid > 0
                ? `At ${dollars(listing.price)}, reselling it as is doesn't clear your targets. The max bid is ${dollars(path.maxBid)}.`
                : "Reselling it as is doesn't clear your targets at any price.",
        ],
        best: path,
        paths: [path],
        assumptions,
    };
}

// Every path, and the verdict: the path that clears your targets by
// the most, or pass. Anything unknown stops the math instead of guessing.
export function underwrite(evaluation, config = MONEY_CONFIG) {
    const { listing, identity, condition } = evaluation;

    if (typeof listing?.price !== "number") {
        return verdict("CANT_PRICE", ["The listing has no price."]);
    }
    if (!readyForPricing(identity)) {
        return verdict("NEEDS_REVIEW", identity?.reasons?.length ? identity.reasons : ["The card isn't identified yet."]);
    }

    const assumptions = [];
    const shipping = listing.shipping ?? config.buying.assumedShippingWhenUnknown;

    if (listing.shipping == null) {
        assumptions.push(`The listing doesn't quote shipping, so ${dollars(shipping)} is assumed.`);
    }
    if (config.verified !== true) {
        assumptions.push("The fees in money.config.js haven't been checked against your accounts yet.");
    }

    if (evaluation.slab) {
        return underwriteSlab(evaluation, shipping, config, assumptions);
    }

    if (!condition) {
        return verdict("NEEDS_REVIEW", evaluation.modeReasons?.length ? evaluation.modeReasons : ["There's no condition estimate from the photos."]);
    }
    if (condition.authenticity.concern === "LIKELY_FAKE") {
        return verdict("PASS", ["The photos suggest the card may be fake.", ...condition.authenticity.reasons]);
    }
    if (condition.authenticity.concern !== "NONE_SEEN") {
        return verdict("NEEDS_REVIEW", ["The photos raise an authenticity question.", ...condition.authenticity.reasons]);
    }

    const paths = [
        rawPath(evaluation, shipping, config),
        ...GRADERS.map((grader) => gradePath(evaluation, grader, shipping, config)),
    ];

    const priced = paths.filter((path) => path.status === "PRICED");
    const clearing = priced.filter((path) => path.clears);

    if (clearing.length > 0) {
        const best = clearing.reduce((a, b) => (b.profit > a.profit ? b : a));

        return {
            verdict: best.path === "RAW" ? "BUY_RAW" : "BUY_AND_GRADE",
            reasons: [],
            best,
            paths,
            assumptions,
        };
    }

    if (priced.length > 0) {
        const best = priced.reduce((a, b) => (b.maxBid > a.maxBid ? b : a));

        return {
            verdict: "PASS",
            reasons: [
                best.maxBid > 0
                    ? `At ${dollars(listing.price)}, no path clears your targets. The best max bid is ${dollars(best.maxBid)} (${best.label.toLowerCase()}).`
                    : `No path clears your targets at any price.`,
            ],
            best,
            paths,
            assumptions,
        };
    }

    return {
        verdict: "CANT_PRICE",
        reasons: paths.map((path) => `${path.label}: ${path.reason}`),
        best: null,
        paths,
        assumptions,
    };
}
