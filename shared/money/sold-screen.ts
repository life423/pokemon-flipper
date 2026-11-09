import { CONDITION_NAMES, isRawCondition } from "../conditions.ts";
import type { ListingSummary, Screen, ScreeningSoldEvidence, ScreeningSoldReference, Targets } from "../types.ts";
import { MONEY_CONFIG, type MoneyConfig } from "./config.ts";
import { offerPlan, offerWorthMaking } from "./offer.ts";
import { bestPath, gradingTier, netFromSale, pathNumbers } from "./underwriting.ts";
import { hasExactSoldScope, usableSoldReference } from "../sold-evidence.ts";

type SoldScreenListing = Pick<ListingSummary, "currentPrice" | "shipping" | "isGraded" | "buyingOption" | "bestOffer" | "screen">;
interface SoldScreenOptions {
    targets?: Targets;
    includeOffers?: boolean;
    config?: MoneyConfig;
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase();

function label(reference: ScreeningSoldReference, slab: boolean): string {
    return slab ? `Preliminary ${normalize(reference.grader)} ${reference.grade} resale` :
        `Sold-title ${CONDITION_NAMES[reference.condition!]} raw comparison`;
}

function gradingLead(listing: SoldScreenListing, evidence: ScreeningSoldEvidence, config: MoneyConfig): Screen["gradingLead"] {
    const price = listing.currentPrice, shipping = listing.shipping ?? config.buying.assumedShippingWhenUnknown;
    if (listing.isGraded || listing.buyingOption !== "FIXED_PRICE" || !evidence.exactScope || price === null ||
        !Number.isFinite(price) || price < 0 || !Number.isFinite(shipping) || shipping < 0) return undefined;
    const references = (evidence.gradingReferences ?? []).filter(reference =>
        (reference.grade === "8" || reference.grade === "9") && usableSoldReference(reference, true) &&
        reference.summary.windowDays === 90 &&
        (!listing.screen?.card?.printing || listing.screen.card.printing === "UNKNOWN" || reference.printing === listing.screen.card.printing));
    // A profitable sale at a scout grade buys research only. The actual card
    // still needs a supported grade range and downside pricing after review.
    for (const grade of [8, 9]) {
        for (const reference of references) {
            const grader = reference.grader;
            if ((grader !== "PSA" && grader !== "CGC") || Number(reference.grade) !== grade) continue;
            const salePrice = reference.summary.median!;
            const tier = gradingTier(grader, salePrice, config.grading);
            if (!tier) continue;
            const numbers = pathNumbers({ price, shipping, expectedNet: netFromSale(reference.summary.low ?? salePrice, "graded", config.selling),
                fixedCosts: tier.fee + config.grading.shippingPerCard }, config);
            if (numbers.clears) return { grader, grade };
        }
    }
    return undefined;
}

// Price-first admission, not a deal verdict. Slab exclusion uses the highest
// recent sold amount in one explicit scope, whereas queue priority uses its
// median. Raw sold-condition buckets supply context only: neither a seller's
// condition nor a hypothetical numeric grade is assigned to the live card.
// This module intentionally has no dependency on targets.ts: local retargeting
// delegates here and reuses the same retained public references.
export function applySoldPriceScreen<T extends SoldScreenListing>(
    listing: T,
    evidence: ScreeningSoldEvidence,
    options: SoldScreenOptions = {}
): T & { screen: Screen } {
    const config = options.config ?? MONEY_CONFIG;
    const moneyConfig = { ...config, targets: options.targets ?? config.targets };
    const previous = listing.screen;
    const screen: Screen = {
        ...previous,
        status: "UNSCREENED",
        reason: evidence.note,
        card: previous?.card ?? null,
        bestCase: null,
        assumed: null,
        soldEvidence: evidence,
        needsAnalysis: listing.isGraded ? "SLAB_LABEL" : "IDENTITY",
        requiresOffer: false,
    };
    // Never retain an unrelated legacy ceiling when the new sold check cannot
    // price it. Original photo/card evidence and focused-review flags survive.
    delete screen.money;
    delete screen.gradingLead;

    const finish = () => ({ ...listing, screen });
    if (evidence.status !== "AVAILABLE") {
        if (evidence.status === "UNAVAILABLE") {
            const lead = gradingLead(listing, evidence, moneyConfig);
            if (lead) {
                screen.gradingLead = lead;
                screen.reason = `Recent ${lead.grader} ${lead.grade} sales leave room after costs if this copy earns that grade. Photos still need to support a grade range.`;
            }
        }
        return finish();
    }

    const references = evidence.references.filter((reference) => usableSoldReference(reference, listing.isGraded));
    if (!references.length) {
        screen.soldEvidence = { ...evidence, status: "UNAVAILABLE", note: "No usable recent matched sold-price reference is available." };
        screen.reason = screen.soldEvidence.note;
        return finish();
    }

    if (!hasExactSoldScope(evidence, screen.card?.printing)) {
        screen.reason = "Sold references remain separate market context. The listing's printing, finish and grade must identify one matching market before estimating profit or a purchase limit.";
        return finish();
    }

    const price = listing.currentPrice;
    const shipping = listing.shipping ?? 0;
    if (price === null || !Number.isFinite(price) || price < 0 || !Number.isFinite(shipping) || shipping < 0) {
        screen.reason = "A valid purchase price and shipping amount are needed before preliminary cost screening.";
        return finish();
    }

    const pricedReferences = references.filter((reference) => listing.isGraded || isRawCondition(reference.condition));
    if (!pricedReferences.length) {
        screen.reason = "Recent matching raw sales are available as market context, but their condition is unspecified. The live card still needs photo assessment.";
        return finish();
    }

    const kind = listing.isGraded ? "graded" : "raw";
    const paths = pricedReferences.map((reference) => ({
        label: label(reference, listing.isGraded),
        path: listing.isGraded ? "GRADED_RESALE" as const : "RAW" as const,
        rawCondition: reference.condition ?? undefined,
        expectedNet: netFromSale(reference.summary.median!, kind, config.selling),
        downsideNet: positive(reference.summary.low) ? netFromSale(reference.summary.low, kind, config.selling) : undefined,
        fixedCosts: 0,
        compCount: reference.summary.count,
        compConfidence: reference.summary.confidence,
    }));
    const priced = paths.map((path) => ({ ...path, ...pathNumbers({ ...path, shipping, price }, moneyConfig) }));
    if (priced.some((path) => ![path.cost, path.profit, path.maxBid, path.expectedNet].every(Number.isFinite))) {
        screen.reason = "The configured purchase or sale costs cannot produce a valid preliminary estimate.";
        return finish();
    }

    screen.money = {
        shipping,
        paths,
        auction: listing.buyingOption === "AUCTION",
        bestOffer: listing.bestOffer === true,
        usual: listing.isGraded ? {
            price: references[0].summary.median!,
            sales: references[0].summary.sales.map((sale) => sale.price).filter(positive),
        } : null,
    };
    screen.assumed = "Preliminary sold-title comparisons; photos have not confirmed this card's identity, label or condition." +
        (listing.shipping === null ? " Purchase shipping is unknown; $0 is used only to avoid excluding a possible opportunity." : "");

    if (!listing.isGraded) {
        screen.reason = "Matched raw sold-condition buckets inform priority only. Photos must establish this card's condition and any grading upside.";
        return finish();
    }

    // A missing/older/ambiguous upper reference cannot justify rejecting a
    // listing. Multiple printings/finishes/grades are never blended together.
    const canExclude = references.every((reference) =>
        reference.summary.windowDays! <= 90 && positive(reference.summary.high));
    if (!canExclude) {
        screen.reason = "Preliminary sold comparisons are available, but a single exact recent slab scope is not established. Label assessment is still needed.";
        return finish();
    }
    const upper = bestPath(references.map((reference) => ({
        label: `${label(reference, true)} at upper observed sold price`,
        ...pathNumbers({ expectedNet: netFromSale(reference.summary.high!, "graded", config.selling), fixedCosts: 0, shipping, price }, moneyConfig),
    })))!;
    screen.bestCase = { label: upper.label, maxBid: upper.maxBid, profit: upper.profit, roi: upper.roi };
    screen.requiresOffer = !upper.clears && options.includeOffers === true && listing.buyingOption === "FIXED_PRICE" &&
        listing.bestOffer === true && offerWorthMaking(offerPlan(price, upper.maxBid));
    screen.status = upper.clears || screen.requiresOffer ? "CANDIDATE" : "DROPPED";
    if (screen.status === "DROPPED") {
        screen.needsAnalysis = undefined;
        screen.reason = "Above target even using the upper recent matched sold price after purchase and sale costs. This preliminary screen does not require paid photo analysis.";
    } else screen.reason = screen.requiresOffer
        ? "Preliminary opportunity only if the seller accepts an offer within 10% of asking; photos and the slab label still need confirmation."
        : "The upper recent matched sold price leaves possible room; this is preliminary and the slab label still needs confirmation.";
    return finish();
}
