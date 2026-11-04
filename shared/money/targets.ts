import { MONEY_CONFIG, type MoneyConfig } from "./config.ts";
import { bestPath, netFromSale, pathNumbers, underwrite } from "./underwriting.ts";
import { rateDeal } from "./rating.ts";
import { offerPlan, offerWorthMaking } from "./offer.ts";
import type { Evaluation, ListingSummary, Screen, Targets } from "../types.ts";
import { withFreshListing } from "../fresh-listing.ts";
import { applySoldPriceScreen } from "./sold-screen.ts";
import { deferJungleNoSymbolPricing } from "../jungle-no-symbol.ts";

// Your profit and return targets change by card, so the page re-prices
// everything for the targets you set. The same money math runs on the
// numbers the server already gathered: no new lookups, no AI.

export function withTargets(targets: Targets, config: MoneyConfig = MONEY_CONFIG): MoneyConfig {
    return { ...config, targets };
}

// An analyzed listing: every path, the verdict, and the rating, redone.
export function retargetEvaluation(evaluation: Evaluation, targets: Targets, current?: ListingSummary): Evaluation {
    if (current) current = withFreshListing(current, evaluation);
    // Keep the saved photo assessment, but use the latest search's purchase
    // terms. A missing shipping quote falls back to the listing details,
    // just as it does when the server evaluates a search result.
    const updated = current
        ? {
              ...evaluation,
              listing: {
                  ...evaluation.listing,
                  availability: current.availability ?? evaluation.listing.availability,
                  price: current.currentPrice,
                  shipping: current.termsCheckedAt ? current.shipping : current.shipping ?? evaluation.listing.shipping,
                  bids: current.bids,
                  endTime: current.endTime,
                  buyingOption: current.buyingOption,
                  seller: current.seller ?? evaluation.listing.seller,
              },
          }
        : evaluation;
    const scoped = deferJungleNoSymbolPricing(updated);
    const underwriting = underwrite(scoped, withTargets(targets));
    const repriced = { ...scoped, underwriting };

    return { ...repriced, rating: rateDeal(repriced) };
}

// A free check: whether the listing could clear your targets at its
// best, from the paths it priced.
export function retargetScreen(
    screen: Screen,
    price: number | null,
    targets: Targets,
    config: MoneyConfig = MONEY_CONFIG,
    includeOffers = false
): Screen {
    if (screen.soldEvidence) {
        if (screen.soldEvidence.status !== "AVAILABLE" || !screen.money || price === null) return screen;
        // Median-price paths rank the queue; the retained sold sample decides
        // whether a slab's upper recent outcome can still meet these targets.
        // Raw-only paths never establish that grading cannot be worthwhile.
        const updated = applySoldPriceScreen({ currentPrice: price, shipping: screen.money.shipping,
            isGraded: screen.money.paths.some(path => path.path === "GRADED_RESALE"),
            buyingOption: screen.money.auction ? "AUCTION" : "FIXED_PRICE", bestOffer: screen.money.bestOffer, screen },
        screen.soldEvidence, { targets, config, includeOffers }).screen;
        // The original note also records whether preliminary shipping was an
        // unquoted zero-dollar screening assumption, rather than a real quote.
        return screen.assumed ? { ...updated, assumed: screen.assumed } : updated;
    }
    if (!screen.money || price === null || screen.status === "UNSCREENED" && !screen.conditionUpside && !screen.money.priceEvidenceIncomplete) return screen;

    const repriced = withTargets(targets, config);
    const { shipping, paths } = screen.money;
    const priced = paths.map((path) => ({
        label: path.label,
        ...pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping, price }, repriced),
    }));
    const best = bestPath(priced);

    if (!best) return screen;
    const requiresOffer = !best.clears && includeOffers && screen.money.bestOffer === true &&
        offerWorthMaking(offerPlan(price, best.maxBid));
    const unresolved = Boolean(screen.money.priceEvidenceIncomplete && !best.clears && !requiresOffer);
    const incompleteReason = "The preliminary estimates do not clear your current targets, but missing resale evidence leaves raw-card grading or condition upside unresolved. These estimates do not establish a verified deal or a completed price exclusion.";

    const repricedScreen: Screen = {
        ...screen,
        status: best.clears || requiresOffer ? "CANDIDATE" : unresolved ? "UNSCREENED" : "DROPPED",
        ...(screen.money.priceEvidenceIncomplete ? { needsAnalysis: unresolved ? "PRICE_EVIDENCE" : undefined,
            reason: unresolved ? incompleteReason : "Seller-based price estimates could clear your targets. Matched resale evidence and photos are still required; this is not a verified deal." } : {}),
        requiresOffer,
        bestCase: { label: best.label, maxBid: best.maxBid, profit: best.profit, roi: best.roi },
    };
    if (!screen.conditionUpside) return repricedScreen;
    if (repricedScreen.status === "CANDIDATE") return { ...repricedScreen, needsAnalysis: undefined };
    const upside = pathNumbers({ expectedNet: netFromSale(screen.conditionUpside.rawMarketPrice, "raw", config.selling), fixedCosts: 0, shipping, price }, repriced);
    return { ...repricedScreen, status: upside.clears || unresolved ? "UNSCREENED" : "DROPPED", needsAnalysis: upside.clears ? "IDENTITY" : unresolved ? "PRICE_EVIDENCE" : undefined,
        reason: upside.clears ? "The saved better-condition raw market quote could clear your current targets. Photos must verify that condition; this is not a verified deal."
            : unresolved ? incompleteReason : "Even the better-condition raw market quote does not clear your current targets. Manual analysis remains available." };
}
