import { identifyCard, printingClaimFromText, readyForPricing } from "../identity/card-identity.ts";
import { graderCode, normalizeGrade } from "../identity/slab-check.ts";
import { rawPricesFor } from "../pricing/raw-prices.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import type { CheckComps, FetchComps, LookupCards } from "../pricing/types.ts";
import { sellerCondition } from "../../shared/conditions.ts";
import { GRADERS, underwrite, type UnderwritingInput } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG, type MoneyConfig } from "../../shared/money/config.ts";
import { CONDITION_NAMES } from "../../shared/conditions.ts";
import type { BuyingOption, Grader, Screen, Underwriting } from "../../shared/types.ts";
import { usualPrice } from "../../shared/money/auction.ts";
import { retargetScreen } from "../../shared/money/targets.ts";

// The free first check, before any paid AI: what a listing is worth at
// its best, from the seller's own details and the price data. A listing
// that can't clear your targets even then is dropped. One that can is
// only a candidate: the AI's look at the photos decides.

// What the free check reads from a listing.
export interface ScreenInput {
    title: string;
    aspects: Record<string, string>;
    price: number | null;
    shipping: number | null;
    isGraded: boolean;
    cardCondition: string | null;
    buyingOption?: BuyingOption;
}

export interface ScreenDeps {
    lookupCards: LookupCards;
    fetchComps: FetchComps;
    // The AI's second look at comps; without it, the rules decide alone.
    checkComps?: CheckComps;
    config?: MoneyConfig;
    now?: number;
}

// Printing marks that agree with the seller, standing in for photos.
// Sellers name the pricier printings, so with no claim it's Unlimited.
const SELLER_MARKS = {
    FIRST_EDITION: { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" },
    SHADOWLESS: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" },
    UNLIMITED: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
} as const;

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

function screen(status: Screen["status"], reason: string | null, extra: Partial<Screen> = {}): Screen {
    return { status, reason, card: null, bestCase: null, assumed: null, ...extra };
}

export async function prescreen(listing: ScreenInput, deps: ScreenDeps): Promise<Screen> {
    const { lookupCards, fetchComps, checkComps, config = MONEY_CONFIG, now = Date.now() } = deps;

    if (typeof listing.price !== "number") {
        return screen("UNSCREENED", "The listing has no price.");
    }

    const { aspects } = listing;
    const printing = sellerPrinting(listing);

    // The identity code, run on the seller's word instead of photos.
    const sellerView = {
        printingMarks: printing ? SELLER_MARKS[printing] : undefined,
        printedName: null,
        printedNumber: aspects["Card Number"] ? null : (listing.title.match(TITLE_NUMBER)?.[1].replace(/\s/g, "") ?? null),
        slab: null,
    };

    let identified;

    try {
        identified = await identifyCard(listing, sellerView, { lookupCards });
    } catch (error) {
        return screen("UNSCREENED", `The card lookup failed: ${(error as Error).message}`);
    }

    const { identity, card } = identified;

    if (!readyForPricing(identity)) {
        return screen("UNSCREENED", identity.reasons[0] ?? "The card couldn't be identified from the listing.");
    }

    const cardInfo: Screen["card"] = {
        name: identity.name,
        set: identity.set,
        cardNumber: identity.cardNumber,
        printing: identity.printing,
        printingLabel: identity.printingLabel,
    };

    const input: UnderwritingInput = {
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
                return screen("UNSCREENED", "The listing doesn't give the grader and grade.", { card: cardInfo });
            }

            if (!GRADERS.includes(grader as Grader)) {
                return screen("UNSCREENED", `Only PSA and CGC slabs are priced so far, not ${grader}.`, { card: cardInfo });
            }

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
            input.rawPricing = rawPricesFor(card, identity);
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
        return screen("UNSCREENED", `The price lookup failed: ${(error as Error).message}`, { card: cardInfo });
    }

    const { verdict, reasons, best, paths } = outcome;
    const bestCase = best ? { label: best.label, maxBid: best.maxBid, profit: best.profit, roi: best.roi } : null;
    const priced = paths.filter((path) => path.status === "PRICED");
    const money = best
        ? {
              shipping: best.shipping,
              paths: priced.map((path) => ({ label: path.label, expectedNet: path.expectedNet, fixedCosts: path.fixedCosts })),
              auction: listing.buyingOption === "AUCTION",
              usual: usualPrice(paths, input.slab ? input.slabPricing?.summary : null),
          }
        : undefined;

    if (verdict.startsWith("BUY")) {
        // Flags an auction that will very likely end above its max bid.
        return retargetScreen(screen("CANDIDATE", null, { card: cardInfo, bestCase, assumed, money }), listing.price, config.targets, config);
    }

    if (verdict === "PASS") {
        return screen("DROPPED", reasons[0] ?? null, { card: cardInfo, bestCase, assumed, money });
    }

    return screen("UNSCREENED", reasons[0] ?? "It couldn't be priced.", { card: cardInfo, assumed });
}
