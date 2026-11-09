import { MONEY_CONFIG } from "./money/config.ts";
import { pathNumbers } from "./money/underwriting.ts";
import type { ListingSummary, Targets } from "./types.ts";
import { rawMarketContext, type RawMarketContext } from "./raw-market-context.ts";
import { sellerConditionClues } from "./raw-condition-claim.ts";
import { hasExactSoldScope } from "./sold-evidence.ts";
import { conditionGap } from "./conditions.ts";

export interface AnalysisPriority {
    band: number;
    evidence: number;
    conservativeProfit: number | null;
    expectedProfit: number | null;
    investment: number | null;
    reason: string;
    rawMarketContext?: RawMarketContext | null;
    rawResearchCaution?: "SELLER_DAMAGE" | "SELLER_CONDITION_CONFLICT" | null;
    contextPriority?: boolean;
}

// Availability is a useful hint, not proof of front/back coverage. Different
// thumbnail sizes of the same eBay image are still just one photograph.
export function availablePhotoCount(images: readonly string[]): number {
    return new Set(images.map((url) => url.replace(/\/s-l\d+\./, "/s-l."))).size;
}

// Queue order only: no new prices, photo guesses, probabilities or verdicts.
// Prefer targets supported without a grade increase, then the quality of the
// available evidence. Full identity and condition checks still decide Deals.
export function analysisPriority(listing: ListingSummary, targets: Targets = MONEY_CONFIG.targets): AnalysisPriority {
    const screen = listing.screen;
    const money = screen?.money;
    const price = listing.currentPrice;
    const photos = screen?.evidence?.photos ?? availablePhotoCount(listing.images);
    const photoSupport = Math.min(2, Math.floor(Math.max(0, photos) / 2)) +
        (screen?.evidence?.mainPhoto === "MATCH" ? 2 : screen?.evidence?.mainPhoto === "CANT_TELL" ? -1 : 0) -
        (listing.shipping === null ? 1 : 0);
    const context = rawMarketContext(listing);
    const slabResearch = listing.isGraded || money?.paths.some(path => path.path === "GRADED_RESALE");
    const seller = slabResearch ? null : sellerConditionClues(listing);
    const rawResearchCaution = seller?.severe ? "SELLER_DAMAGE" : seller?.conflict ? "SELLER_CONDITION_CONFLICT" : null;
    const cautionReason = rawResearchCaution === "SELLER_DAMAGE" ? "Seller describes heavy play or damage; inspect supported exceptions after ordinary raw prospects."
        : rawResearchCaution === "SELLER_CONDITION_CONFLICT" ? "Seller condition claims disagree; photos must establish the card's actual condition and grading upside." : null;
    const unknown: AnalysisPriority = { band: 0, evidence: photoSupport, conservativeProfit: null, expectedProfit: null, investment: null,
        rawMarketContext: context, rawResearchCaution, contextPriority: context !== null && context.caution === null && availablePhotoCount(listing.images) >= 2,
        reason: cautionReason ?? (screen?.priceAnomaly && !screen.priceAnomaly.photoChecked
            ? "Unusually low price: awaiting bounded photo verification."
            : context?.caution === "UNUSUALLY_LOW" ? "Unusually low asking price needs verification; its price alone does not establish value."
            : context ? "Research priority compares delivered asking with matching sales of unspecified condition; resale value and grading upside still need assessment."
            : "Photo lead still needs identity or price confirmation.") };
    if (screen?.gradingLead && (!listing.match || listing.match === "UNCONFIRMED_CRITERIA")) {
        return { ...unknown, band: 1, evidence: photoSupport + Number(screen.gradingLead.grade === 8),
            investment: price, reason: screen.reason ?? unknown.reason };
    }
    if (listing.match || (screen?.priceAnomaly && !screen.priceAnomaly.photoChecked) || !money || price === null || !Number.isFinite(price) ||
        screen?.soldEvidence && !hasExactSoldScope(screen.soldEvidence, screen.card?.printing)) return unknown;
    const config = { ...MONEY_CONFIG, targets };
    // The screen's $0 fallback avoids a premature exclusion. Queue ranking
    // uses the normal purchase assumption when delivery has not been quoted.
    const shipping = listing.shipping === null ? MONEY_CONFIG.buying.assumedShippingWhenUnknown : money.shipping;
    // A cleaner sold copy should not move a worn seller-described card up
    // the queue. This changes order only; photos can still establish upside.
    const plausiblePaths = money.paths.filter(path => !path.rawCondition || !seller?.claim || conditionGap(seller.claim, path.rawCondition) >= 0);
    const ranked = plausiblePaths.map((path): AnalysisPriority => {
        const expected = pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping, price }, config);
        const samples = path.compCount ?? 0;
        const compSupport = samples >= 3 && ["HIGH", "MEDIUM", "LOW"].includes(path.compConfidence ?? "")
            ? (path.compConfidence === "HIGH" ? 2 : path.compConfidence === "MEDIUM" ? 1 : 0) + (samples >= 10 ? 2 : 1)
            : 0;
        const asIs = path.path === "RAW" || path.path === "GRADED_RESALE";
        const floorNet = path.path === "RAW" && !listing.isGraded && money.rawFloorNet !== undefined ? Math.min(money.rawFloorNet, path.expectedNet)
            : path.path === "GRADED_RESALE" && samples >= 3 && ["HIGH", "MEDIUM"].includes(path.compConfidence ?? "") ? path.downsideNet : undefined;
        const conservative = floorNet === undefined ? null : pathNumbers({ expectedNet: floorNet, fixedCosts: path.fixedCosts, shipping, price }, config);
        const band = conservative?.clears ? 3 : asIs && expected.clears ? 2 : expected.clears ? 1 : 0;
        return { band, evidence: photoSupport + compSupport, rawMarketContext: context, rawResearchCaution, contextPriority: band === 0 && unknown.contextPriority,
            conservativeProfit: conservative?.profit ?? null, expectedProfit: expected.profit, investment: expected.cost,
            reason: cautionReason ?? (band === 3 ? "Targets fit a lower resale estimate; full photo verification is still required."
                : band === 2 ? "As-is resale estimate meets targets; photos must confirm the card and condition."
                : band === 1 ? "Profit depends on the grading estimate; photo assessment comes next."
                : unknown.reason) };
    });
    return ranked.sort(comparePriority)[0] ?? unknown;
}

// A deterministic comparison avoids a huge optimistic ROI overwhelming
// stronger resale evidence. Lower capital breaks otherwise comparable ties.
export function comparePriority(a: AnalysisPriority, b: AnalysisPriority): number {
    return b.band - a.band || Number(a.rawResearchCaution != null) - Number(b.rawResearchCaution != null) ||
        Number(b.band === 0 && b.contextPriority === true) - Number(a.band === 0 && a.contextPriority === true) ||
        (a.band === 0 && b.band === 0 && a.contextPriority === true && b.contextPriority === true
            ? a.rawMarketContext!.askingToSoldMedian - b.rawMarketContext!.askingToSoldMedian : 0) || b.evidence - a.evidence ||
        (b.conservativeProfit ?? -Number.MAX_VALUE) - (a.conservativeProfit ?? -Number.MAX_VALUE) ||
        (b.expectedProfit ?? -Number.MAX_VALUE) - (a.expectedProfit ?? -Number.MAX_VALUE) ||
        (a.investment ?? Number.MAX_VALUE) - (b.investment ?? Number.MAX_VALUE);
}

export function compareAnalysisPriority(a: ListingSummary, b: ListingSummary, targets?: Targets): number {
    // Stable Array.sort retains eBay/source order on equal evidence. Replacing
    // that order with listing IDs can put older Buy It Now inventory first.
    return Number(a.screen?.status === "DROPPED") - Number(b.screen?.status === "DROPPED") ||
        comparePriority(analysisPriority(a, targets), analysisPriority(b, targets));
}
