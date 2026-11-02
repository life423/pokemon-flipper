import { identifyCard, printingClaimFromText, readyForPricing, sameSetFamily } from "../identity/card-identity.ts";
import { graderCode, normalizeGrade } from "../identity/slab-check.ts";
import { rawPricesFor, variantFor } from "../pricing/raw-prices.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import type { CheckComps, FetchComps, FetchRawComps, LookupCards } from "../pricing/types.ts";
import { rawPricesWithSales } from "../pricing/raw-comps.ts";
import { sellerCondition } from "../../shared/conditions.ts";
import { GRADERS, netFromSale, underwrite, type UnderwritingInput } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG, type MoneyConfig } from "../../shared/money/config.ts";
import { CONDITION_NAMES } from "../../shared/conditions.ts";
import { dollars } from "../../shared/format.ts";
import type { BuyingOption, CompSummary, Screen, Underwriting } from "../../shared/types.ts";
import { usualPrice } from "../../shared/money/auction.ts";
import { retargetScreen } from "../../shared/money/targets.ts";
import { pricingIssue } from "../pricing/errors.ts";
import { MIN_AUTOMATIC_RAW_RESALE, CHEAP_FIRST_EDITION_BASE_SET_LIMIT } from "../../shared/research-policy.ts";

// The preliminary check, before full photo assessment: what a listing is worth at
// its best, from the seller's own details and the price data. A listing
// that can't clear targets is ranked below stronger leads, but can still receive
// AI photo assessment. Seller claims never establish a final deal.

// What the free check reads from a listing.
export interface ScreenInput {
    title: string;
    aspects: Record<string, string>;
    price: number | null;
    shipping: number | null;
    isGraded: boolean;
    cardCondition: string | null;
    buyingOption?: BuyingOption;
    bestOffer?: boolean;
    // Printing marks the main photo showed, where it could tell.
    photoMarks?: { firstEditionStamp: string; artBoxShadow: string };
    // Set only by discovery after a clear, single, non-stock photo reading.
    photoVerified?: boolean;
}

export interface ScreenDeps {
    lookupCards: LookupCards;
    fetchComps: FetchComps;
    fetchRawComps?: FetchRawComps;
    // The AI's second look at comps; without it, the rules decide alone.
    checkComps?: CheckComps;
    config?: MoneyConfig;
    now?: number;
    includeOffers?: boolean;
}

// Printing marks that agree with the seller, standing in for photos.
// Sellers name the pricier printings, so with no claim it's Unlimited.
const SELLER_MARKS = {
    FIRST_EDITION: { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" },
    SHADOWLESS: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" },
    UNLIMITED: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
} as const;

// A very low price calls for verification; it cannot prove a counterfeit.
// Auctions are exempt; a 99-cent starting bid is normal.
const TOO_CHEAP_SHARE = 0.2;

// "4/102" in a title, for listings whose item details skip the number.
const TITLE_NUMBER = /\b(\d{1,3}\s*\/\s*\d{1,3})\b/;

// "PSA 8" or "CGC 9.5" in a title.
const TITLE_GRADE = /\b(psa|cgc|bgs|sgc|tag)\s*(10|[1-9](?:\.5)?)\b/i;

function sellerPrinting(listing: ScreenInput): keyof typeof SELLER_MARKS | null {
    const specifics = Object.entries(listing.aspects)
        .filter(([name]) => /edition|feature|print/i.test(name))
        .map(([, value]) => value)
        .join(" ");

    const claims = [printingClaimFromText(listing.title), printingClaimFromText(specifics)].filter(
        (claim) => claim !== "NOT_STATED"
    );
    const claim = claims[0] ?? "UNLIMITED";

    // A conflicting claim has no marks, so identity sends it to review.
    return claim in SELLER_MARKS ? (claim as keyof typeof SELLER_MARKS) : null;
}

// The photo's printing marks where it could tell, the seller's otherwise, so a
// claim the photo clearly contradicts gets settled by identity.
function withPhotoMarks(
    seller: { firstEditionStamp: string; artBoxShadow: string },
    photo: ScreenInput["photoMarks"]
): { firstEditionStamp: string; artBoxShadow: string } {
    if (!photo) return seller;

    return {
        firstEditionStamp: photo.firstEditionStamp !== "CANT_TELL" ? photo.firstEditionStamp : seller.firstEditionStamp,
        artBoxShadow: photo.artBoxShadow !== "CANT_TELL" ? photo.artBoxShadow : seller.artBoxShadow,
    };
}

function screen(status: Screen["status"], reason: string | null, extra: Partial<Screen> = {}): Screen {
    return { status, reason, card: null, bestCase: null, assumed: null, ...extra };
}

export async function prescreen(listing: ScreenInput, deps: ScreenDeps): Promise<Screen> {
    const { lookupCards, fetchComps, checkComps, config = MONEY_CONFIG, now = Date.now(), includeOffers = false } = deps;

    if (typeof listing.price !== "number") {
        return screen("UNSCREENED", "The listing has no price.");
    }

    const { aspects } = listing;
    const printing = sellerPrinting(listing);

    // The identity code, run on the seller's word instead of photos.
    const sellerView = {
        printingMarks: printing ? withPhotoMarks(SELLER_MARKS[printing], listing.photoMarks) : undefined,
        printedName: null,
        printedNumber: aspects["Card Number"] ? null : (listing.title.match(TITLE_NUMBER)?.[1].replace(/\s/g, "") ?? null),
        slab: null,
    };

    // Missing pieces the listing's own item details might supply.
    const incomplete =
        !aspects.Set || !(aspects["Card Number"] || sellerView.printedNumber) || !(aspects["Card Name"] ?? aspects.Character);

    let identified;
    let lookupIssue: Screen["pricingIssue"];

    try {
        identified = await identifyCard(listing, sellerView, { lookupCards: async (query) => {
            try { return await lookupCards(query); }
            catch (error) { lookupIssue = pricingIssue(error); throw error; }
        } });
    } catch (error) {
        return screen("UNSCREENED", `The card lookup failed: ${(error as Error).message}`, { pricingIssue: pricingIssue(error) });
    }

    const { identity, card } = identified;
    const cheapFirstEditionBaseSet = !listing.isGraded && !identity.notThisCard && !lookupIssue &&
        sameSetFamily(identity.set, "Base Set") && listing.price >= 0 && listing.price <= CHEAP_FIRST_EDITION_BASE_SET_LIMIT &&
        (identity.printing === "FIRST_EDITION" || identity.status !== "IDENTIFIED" && listing.photoMarks?.firstEditionStamp !== "NOT_PRESENT" &&
            (printing === "FIRST_EDITION" || listing.photoMarks?.firstEditionStamp === "VISIBLE"));

    if (!readyForPricing(identity)) {
        return screen("UNSCREENED", identity.reasons[0] ?? "The card couldn't be identified from the listing.", {
            incomplete: incomplete || (!card && !lookupIssue),
            pricingIssue: lookupIssue,
            ...(cheapFirstEditionBaseSet ? { focusedReview: "CHEAP_FIRST_EDITION_BASE_SET" as const } : {}),
            ...(!lookupIssue && !identity.notThisCard ? { needsAnalysis: "IDENTITY" as const } : {}),
        });
    }

    const cardInfo: Screen["card"] = {
        name: identity.name,
        set: identity.set,
        cardNumber: identity.cardNumber,
        printing: identity.printing,
        printingLabel: identity.printingLabel,
        availableFinishes: [...new Set(card?.variants.map((variant) => variant.finish) ?? [])],
    };
    const variant = variantFor(card, identity);
    if (!variant.variant) return screen("UNSCREENED", variant.reason, {
        card: cardInfo, needsAnalysis: "FINISH", incomplete: true,
        ...(cheapFirstEditionBaseSet ? { focusedReview: "CHEAP_FIRST_EDITION_BASE_SET" as const } : {}),
    });

    // Use the feed already returned by identity lookup before researching sold
    // copies or hypothetical grading routes. This is a raw-market research
    // threshold, not a claim that every graded copy must sell below this price.
    const marketRawPrices = rawPricesFor(card, identity);
    const marketQuotes = marketRawPrices.prices?.map(price => price.price) ?? [];
    const marketMaximum = marketQuotes.length ? Math.max(...marketQuotes) : null;
    if (!listing.isGraded && marketMaximum !== null && marketMaximum < MIN_AUTOMATIC_RAW_RESALE) {
        const lowResale = { minimum: MIN_AUTOMATIC_RAW_RESALE, rawMarketMaximum: marketMaximum, cheapFirstEditionBaseSet };
        return screen(cheapFirstEditionBaseSet ? "UNSCREENED" : "DROPPED",
            cheapFirstEditionBaseSet
                ? `Cheap 1st Edition Base Set exception: verify the printing and condition. The highest available raw market quote is ${dollars(marketMaximum)}, below the normal ${dollars(MIN_AUTOMATIC_RAW_RESALE)} research minimum; this is not a verified deal.`
                : `The highest available raw market quote is ${dollars(marketMaximum)}, below the ${dollars(MIN_AUTOMATIC_RAW_RESALE)} automatic research minimum. Graded resale may differ; manual analysis remains available.`,
            { card: cardInfo, lowResale, ...(cheapFirstEditionBaseSet ? { needsAnalysis: "IDENTITY" as const, focusedReview: "CHEAP_FIRST_EDITION_BASE_SET" as const } : {}) });
    }

    // The card's cheapest price in any condition, from the lookup already made.
    const rawPrices = !listing.isGraded && deps.fetchRawComps
        ? await rawPricesWithSales(card, identity, { fetchRawComps: deps.fetchRawComps, checkComps, now })
        : marketRawPrices;
    const floor =
        rawPrices.status === "PRICED" && rawPrices.prices?.length ? Math.min(...rawPrices.prices.map((p) => p.price)) : null;

    const priceAnomaly = listing.buyingOption === "FIXED_PRICE" && floor !== null && listing.price < floor * TOO_CHEAP_SHARE
        ? { referencePrice: floor, photoChecked: listing.photoVerified === true }
        : undefined;
    if (priceAnomaly && !priceAnomaly.photoChecked) {
        return screen(
            "UNSCREENED",
            `At ${dollars(listing.price)}, it's far below the lowest quoted price of ${dollars(floor)}. Photo verification is required; price alone cannot establish a deal or a fake.`,
            { card: cardInfo, priceAnomaly, needsAnalysis: "IDENTITY" }
        );
    }

    const input: UnderwritingInput = {
        pricesCheckedAt: new Date(now).toISOString(),
        listing: { price: listing.price, shipping: listing.shipping },
        identity,
        condition: null,
    };

    let outcome: Underwriting;
    let assumed: string;

    try {
        if (listing.isGraded) {
            const fromTitle = listing.title.match(TITLE_GRADE);
            const grader = graderCode(aspects["Professional Grader"]) ?? (fromTitle ? graderCode(fromTitle[1]) : null);
            const grade = normalizeGrade(aspects.Grade) ?? (fromTitle ? fromTitle[2] : null);

            if (!grader || !grade) {
                return screen("UNSCREENED", "The listing doesn't give the grader and grade.", {
                    card: cardInfo,
                    incomplete: true,
                    needsAnalysis: "SLAB_LABEL",
                });
            }

            // Existing slabs use their own recognized grader and exact grade.
            // GRADERS describes raw-card submission services/fees, not which
            // already-certified cards can be verified and resold.
            input.slab = { status: "OK", grader, grade, reasons: [], concerns: [] };
            input.slabPricing = await compsForGrade(card, identity, { grader, grade, fetchComps, checkComps, now });
            outcome = underwrite(input, config);
            assumed = `${grader} ${grade}, as listed`;
        } else {
            // At its best: the seller's own condition call, and the grade a
            // card in that condition could reach at best.
            const rawCondition = sellerCondition(listing.cardCondition);
            const grade = config.prescreen.bestGrade[rawCondition];
            const gradeRange = { low: grade, likely: grade, high: grade };

            input.condition = { rawCondition, gradeRange, authenticity: { concern: "NONE_SEEN", reasons: [] } };
            input.rawPricing = rawPrices;
            input.gradedPricing = {};

            // Every path is priced, so the page can redo the verdict for
            // any targets. Comps are cached per card, so this stays cheap.
            for (const grader of GRADERS) {
                input.gradedPricing[grader] = await gradedPricesFor(card, identity, gradeRange, {
                    fetchComps,
                    checkComps,
                    grader,
                    now,
                });
            }

            outcome = underwrite(input, config);
            assumed = `${CONDITION_NAMES[rawCondition]}, grading ${grade} at best`;
        }
    } catch (error) {
        return screen("UNSCREENED", `The price lookup failed: ${(error as Error).message}`, { card: cardInfo, priceAnomaly, pricingIssue: pricingIssue(error),
            // A provider's missing/unsupported grader response must still allow
            // photographed label verification and current-comparison fallback.
            ...(listing.isGraded ? { needsAnalysis: "PRICE_EVIDENCE" as const } : {}) });
    }

    const { verdict, reasons, best, paths } = outcome;
    const bestCase = best ? { label: best.label, maxBid: best.maxBid, profit: best.profit, roi: best.roi } : null;
    const priced = paths.filter((path) => path.status === "PRICED");
    const playedPrices = (rawPrices.prices ?? []).filter((price) => ["MODERATELY_PLAYED", "HEAVILY_PLAYED", "DAMAGED"].includes(price.condition));
    const money = best
        ? {
              shipping: best.shipping,
              paths: priced.map((path) => {
                  const summaries = path.path === "GRADED_RESALE" ? [input.slabPricing?.summary]
                      : path.grader ? input.gradedPricing?.[path.grader]?.byGrade : [];
                  const available = (summaries ?? []).filter((summary): summary is CompSummary => Boolean(summary && summary.count > 0));
                  const support = available.reduce<CompSummary | undefined>((least, summary) =>
                      !least || summary.count < least.count ? summary : least, undefined);
                  return { label: path.label, expectedNet: path.expectedNet, fixedCosts: path.fixedCosts,
                      path: path.path, downsideNet: path.downside + path.cost,
                      compCount: support?.count, compConfidence: support?.confidence };
              }),
              ...(playedPrices.length ? { rawFloorNet: netFromSale(Math.min(...playedPrices.map((price) => price.price)), "raw", config.selling) } : {}),
              auction: listing.buyingOption === "AUCTION",
              usual: usualPrice(paths, input.slab ? input.slabPricing?.summary : null),
              bestOffer: listing.bestOffer,
          }
        : undefined;

    if (verdict.startsWith("BUY") || verdict === "PASS") {
        // Reprice the supported paths against the current purchase targets.
        const screened = retargetScreen(screen("DROPPED", reasons[0] ?? null, { card: cardInfo, bestCase, assumed, money, priceAnomaly }), listing.price, config.targets, config, includeOffers);
        const claimed = sellerCondition(listing.cardCondition);
        const betterConditions = claimed === "LIGHTLY_PLAYED" ? ["NEAR_MINT", "MINT"] as const
            : claimed === "NEAR_MINT" ? ["MINT"] as const : [];
        if (!listing.isGraded && screened.status === "DROPPED" && input.condition) {
            for (const targetCondition of betterConditions) {
                const quote = marketRawPrices.prices?.find(price => price.condition === targetCondition && price.price >= MIN_AUTOMATIC_RAW_RESALE);
                if (!quote) continue;
                // A hypothetical improvement can justify looking at the photos,
                // never replacing the seller's claim or declaring a final deal.
                // This reuses feed quotes and money math, with no new comp calls.
                const alternative = underwrite({ ...input, rawPricing: marketRawPrices, gradedPricing: null,
                    condition: { ...input.condition, rawCondition: targetCondition } }, config);
                if (alternative.verdict !== "BUY_RAW") continue;
                return { ...screened, status: "UNSCREENED", needsAnalysis: "IDENTITY",
                    conditionUpside: { sellerCondition: claimed, targetCondition, rawMarketPrice: quote.price },
                    reason: `Listed ${CONDITION_NAMES[claimed]}. If photos instead support ${CONDITION_NAMES[targetCondition]}, the ${dollars(quote.price)} raw market quote could clear your targets. AI must verify the condition; this is not a verified deal.` };
            }
        }
        return screened;
    }

    return screen("UNSCREENED", reasons[0] ?? "It couldn't be priced.", { card: cardInfo, assumed, priceAnomaly,
        ...(verdict === "CANT_PRICE" ? { needsAnalysis: "PRICE_EVIDENCE" as const } : {}) });
}
