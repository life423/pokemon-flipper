import { readyForPricing } from "../identity/card-identity.ts";
import { MONEY_CONFIG, type BuyingConfig, type GradingConfig, type MoneyConfig, type SellingConfig } from "../config/money.ts";
import { RAW_CONDITIONS, isRawCondition } from "../../shared/conditions.ts";
import { dollars, round2 } from "../../shared/format.ts";
import type {
    CompSummary,
    Condition,
    Grader,
    GradeRange,
    GradedPricing,
    Identity,
    MoneyPath,
    PathKind,
    PricedPath,
    RawPricing,
    Slab,
    SlabPricing,
    UnavailablePath,
    Underwriting,
    Verdict,
} from "../../shared/types.ts";

// The money math. Pure code, no AI: every number comes from the
// evaluation and money config, so the same inputs always give the same
// verdict.

export const GRADERS: Grader[] = ["PSA", "CGC"];

// What the money math reads from an evaluation. The free check builds
// one of these from the seller's details; the full analysis, from the
// photos.
export interface UnderwritingInput {
    listing: { price: number | null; shipping: number | null };
    identity: Identity | null;
    condition: Pick<Condition, "rawCondition" | "gradeRange" | "authenticity"> | null;
    rawPricing?: RawPricing | null;
    gradedPricing?: Partial<Record<Grader, GradedPricing>> | null;
    slab?: Pick<Slab, "status" | "grader" | "grade" | "reasons" | "concerns"> | null;
    slabPricing?: SlabPricing | null;
    modeReasons?: string[];
}

type PricedListing = { price: number; shipping: number | null };

// eBay's fee on one sale: a percentage of everything the buyer pays
// (their sales tax included), tiered above the limit, plus the per-order
// fee and any Promoted Listings rate.
export function ebaySellingFees(salePrice: number, selling: SellingConfig): number {
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
export function netFromSale(salePrice: number, kind: "raw" | "graded", selling: SellingConfig): number {
    return round2(salePrice - ebaySellingFees(salePrice, selling) - selling.shipping[kind]);
}

// What a purchase costs: price plus shipping, plus sales tax on both.
export function acquisitionCost(price: number, shipping: number, buying: BuyingConfig): number {
    return round2((price + shipping) * (1 + buying.salesTaxRate));
}

// The cheapest service level whose cap covers the card's value.
export function gradingTier(grader: Grader, declaredValue: number, grading: GradingConfig) {
    const allowed = grading[grader].filter(
        (tier) => tier.maxDeclaredValue !== null && declaredValue <= tier.maxDeclaredValue
    );

    if (allowed.length === 0) return null;

    const cost = (tier: (typeof allowed)[number]) => tier.fee + (tier.percentOfValue ?? 0) * declaredValue;
    const best = allowed.reduce((a, b) => (cost(b) < cost(a) ? b : a));

    return { grader, tier: best.tier, fee: round2(cost(best)) };
}

// The grade range as probabilities, decided in code: the likely grade
// counts most and each step away counts less. With no likely grade
// (limited evidence), every grade in the range is equally likely.
export function gradeProbabilities({ low, likely, high }: GradeRange) {
    const grades: number[] = [];
    for (let grade = low; grade <= high; grade += 1) grades.push(grade);

    const weights = grades.map((grade) => (likely === null ? 1 : 1 / (1 + Math.abs(grade - likely))));
    const total = weights.reduce((sum, weight) => sum + weight, 0);

    return grades.map((grade, index) => ({ grade, probability: weights[index] / total }));
}

type GradePrices =
    | { ok: true; prices: Record<number, { price: number; filledFrom: number | null }> }
    | { ok: false; reason: string };

// The median sold price for each grade in the range. A grade with no
// verified sales takes the price of the nearest lower grade that has
// some, never a higher one. With nothing below it, there's no floor.
export function pricesByGrade(byGrade: CompSummary[], { low, high }: Pick<GradeRange, "low" | "high">): GradePrices {
    const known = new Map<number, number>();

    for (const summary of byGrade) {
        if (summary.count > 0 && typeof summary.median === "number") {
            known.set(Number(summary.grade), summary.median);
        }
    }

    const prices: Record<number, { price: number; filledFrom: number | null }> = {};
    let floor: { grade: number; price: number } | null = null;

    for (let grade = low; grade <= high; grade += 1) {
        const price = known.get(grade);

        if (price !== undefined) {
            floor = { grade, price };
            prices[grade] = { price, filledFrom: null };
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
export function maxBid(
    { expectedNet, fixedCosts, shipping }: { expectedNet: number; fixedCosts: number; shipping: number },
    config: MoneyConfig
): number {
    const { minProfit, minRoi } = config.targets;
    const costCap = Math.min(expectedNet - minProfit, expectedNet / (1 + minRoi));
    const bid = (costCap - fixedCosts) / (1 + config.buying.salesTaxRate) - shipping;

    return bid > 0 ? Math.floor(bid) : 0;
}

function unavailablePath(path: PathKind, label: string, reason: string, grader?: Grader): UnavailablePath {
    return grader ? { path, label, status: "UNAVAILABLE", reason, grader } : { path, label, status: "UNAVAILABLE", reason };
}

interface PathMoney {
    path: PathKind;
    label: string;
    expectedNet: number;
    downsideNet: number;
    fixedCosts: number;
    listing: PricedListing;
    shipping: number;
    config: MoneyConfig;
}

function pricedPath(
    { path, label, expectedNet, downsideNet, fixedCosts, listing, shipping, config }: PathMoney,
    extra: Partial<PricedPath> = {}
): PricedPath {
    const totalCost = (price: number) => round2(acquisitionCost(price, shipping, config.buying) + fixedCosts);
    const cost = totalCost(listing.price);
    const profit = round2(expectedNet - cost);
    const limit = maxBid({ expectedNet, fixedCosts, shipping }, config);
    const costAtLimit = limit > 0 ? totalCost(limit) : null;
    const profitAtMaxBid = costAtLimit === null ? null : round2(expectedNet - costAtLimit);

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
        profitAtMaxBid,
        roiAtMaxBid: costAtLimit && profitAtMaxBid !== null ? round2(profitAtMaxBid / costAtLimit) : null,
        ...extra,
    };
}

// Path 1: buy raw, resell raw at the assessed condition's price.
export function rawPath(input: UnderwritingInput, listing: PricedListing, shipping: number, config: MoneyConfig): MoneyPath {
    const label = "Resell raw";
    const { rawPricing, condition } = input;

    if (rawPricing?.status !== "PRICED") {
        return unavailablePath("RAW", label, rawPricing?.reason ?? "There's no raw price.");
    }

    if (!condition || !isRawCondition(condition.rawCondition)) {
        return unavailablePath("RAW", label, "The photos don't support a raw condition, so the raw price is unknown.");
    }

    // The assessed condition's price, or the nearest worse condition's.
    // Never a better one.
    const entry = RAW_CONDITIONS.slice(RAW_CONDITIONS.indexOf(condition.rawCondition))
        .map((name) => rawPricing.prices?.find((price) => price.condition === name))
        .find((price) => price !== undefined);

    if (!entry || !isRawCondition(entry.condition)) {
        return unavailablePath("RAW", label, "There's no raw price at the assessed condition or below.");
    }

    const net = netFromSale(entry.price, "raw", config.selling);

    return pricedPath(
        { path: "RAW", label, expectedNet: net, downsideNet: net, fixedCosts: 0, listing, shipping, config },
        { salePrice: entry.price, priceCondition: entry.condition }
    );
}

// Path 2: buy raw, grade with one grader, resell. Priced across the
// whole grade range, with that grader's own sold comps.
export function gradePath(
    input: UnderwritingInput,
    grader: Grader,
    listing: PricedListing,
    shipping: number,
    config: MoneyConfig
): MoneyPath {
    const label = `Grade with ${grader}`;
    const graded = input.gradedPricing?.[grader];

    if (graded?.status !== "PRICED" || !input.condition) {
        return unavailablePath("GRADE", label, graded?.reason ?? `There are no ${grader} sales to price with.`, grader);
    }

    const { gradeRange } = input.condition;
    const byGrade = pricesByGrade(graded.byGrade ?? [], gradeRange);

    if (!byGrade.ok) {
        return unavailablePath("GRADE", label, byGrade.reason, grader);
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
            `No ${grader} service level in the money config covers a card worth ${dollars(declaredValue)}.`,
            grader
        );
    }

    return pricedPath(
        {
            path: "GRADE",
            label,
            expectedNet: outlook.reduce((sum, o) => sum + o.probability * o.net, 0),
            downsideNet: outlook[0].net,
            fixedCosts: tier.fee + config.grading.shippingPerCard,
            listing,
            shipping,
            config,
        },
        {
            grader,
            tier: tier.tier,
            gradingFee: tier.fee,
            expectedSale: round2(outlook.reduce((sum, o) => sum + o.probability * o.price, 0)),
            outlook,
        }
    );
}

// Path 3: buy a graded card and resell it as is, priced from sold
// comps for its exact grader, grade, and printing.
export function gradedResalePath(
    listing: PricedListing,
    comps: CompSummary,
    shipping: number,
    config: MoneyConfig
): MoneyPath {
    const label = `Resell as ${comps.grader} ${comps.grade}`;

    if (!(comps.count > 0) || comps.median === null || comps.low === null) {
        return unavailablePath("GRADED_RESALE", label, `No verified ${comps.grader} ${comps.grade} sales.`);
    }

    return pricedPath(
        {
            path: "GRADED_RESALE",
            label,
            expectedNet: netFromSale(comps.median, "graded", config.selling),
            downsideNet: netFromSale(comps.low, "graded", config.selling),
            fixedCosts: 0,
            listing,
            shipping,
            config,
        },
        { salePrice: comps.median }
    );
}

function verdict(name: Verdict, reasons: string[], assumptions: string[] = []): Underwriting {
    return { verdict: name, reasons, best: null, paths: [], assumptions };
}

const isPriced = (path: MoneyPath): path is PricedPath => path.status === "PRICED";

// Path 3: a graded card, resold as is.
function underwriteSlab(
    slab: NonNullable<UnderwritingInput["slab"]>,
    slabPricing: SlabPricing | null | undefined,
    listing: PricedListing,
    shipping: number,
    config: MoneyConfig,
    assumptions: string[]
): Underwriting {
    if (slab.status === "LIKELY_FAKE") {
        return verdict("PASS", ["The slab or label looks fake.", ...slab.concerns]);
    }

    if (slab.status !== "OK") {
        return verdict("NEEDS_REVIEW", slab.reasons);
    }

    if (slabPricing?.status !== "PRICED" || !slabPricing.summary) {
        return verdict(
            "CANT_PRICE",
            [slabPricing?.reason ?? `There are no ${slab.grader} ${slab.grade} sales to price with.`],
            assumptions
        );
    }

    const path = gradedResalePath(listing, slabPricing.summary, shipping, config);

    if (!isPriced(path)) {
        return { ...verdict("CANT_PRICE", [path.reason], assumptions), paths: [path] };
    }

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
export function underwrite(input: UnderwritingInput, config: MoneyConfig = MONEY_CONFIG): Underwriting {
    const { identity, condition } = input;
    const price = input.listing?.price;

    if (typeof price !== "number") {
        return verdict("CANT_PRICE", ["The listing has no price."]);
    }

    if (!readyForPricing(identity)) {
        return verdict("NEEDS_REVIEW", identity?.reasons?.length ? identity.reasons : ["The card isn't identified yet."]);
    }

    const listing: PricedListing = { price, shipping: input.listing.shipping };
    const assumptions: string[] = [];
    const shipping = listing.shipping ?? config.buying.assumedShippingWhenUnknown;

    if (listing.shipping === null || listing.shipping === undefined) {
        assumptions.push(`The listing doesn't quote shipping, so ${dollars(shipping)} is assumed.`);
    }

    if (config.verified !== true) {
        assumptions.push("The fees in the money config haven't been checked against your accounts yet.");
    }

    if (input.slab) {
        return underwriteSlab(input.slab, input.slabPricing, listing, shipping, config, assumptions);
    }

    if (!condition) {
        return verdict(
            "NEEDS_REVIEW",
            input.modeReasons?.length ? input.modeReasons : ["There's no condition estimate from the photos."]
        );
    }

    if (condition.authenticity.concern === "LIKELY_FAKE") {
        return verdict("PASS", ["The photos suggest the card may be fake.", ...condition.authenticity.reasons]);
    }

    if (condition.authenticity.concern !== "NONE_SEEN") {
        return verdict("NEEDS_REVIEW", ["The photos raise an authenticity question.", ...condition.authenticity.reasons]);
    }

    const paths = [
        rawPath(input, listing, shipping, config),
        ...GRADERS.map((grader) => gradePath(input, grader, listing, shipping, config)),
    ];
    const priced = paths.filter(isPriced);
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
                    : "No path clears your targets at any price.",
            ],
            best,
            paths,
            assumptions,
        };
    }

    return {
        verdict: "CANT_PRICE",
        reasons: paths.map((path) => `${path.label}: ${isPriced(path) ? "" : path.reason}`),
        best: null,
        paths,
        assumptions,
    };
}
