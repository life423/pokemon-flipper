import { MONEY_CONFIG } from "./money/config.ts";
import { pathNumbers } from "./money/underwriting.ts";
import type { ListingSummary, Targets } from "./types.ts";

export interface AnalysisPriority {
    band: number;
    evidence: number;
    conservativeProfit: number | null;
    expectedProfit: number | null;
    investment: number | null;
    reason: string;
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
    const unknown: AnalysisPriority = { band: 0, evidence: photoSupport, conservativeProfit: null, expectedProfit: null, investment: null,
        reason: screen?.priceAnomaly && !screen.priceAnomaly.photoChecked
            ? "Unusually low price: awaiting bounded photo verification."
            : "Photo lead still needs identity or price confirmation." };
    if (listing.match || (screen?.priceAnomaly && !screen.priceAnomaly.photoChecked) || !money || price === null || !Number.isFinite(price)) return unknown;
    const config = { ...MONEY_CONFIG, targets };
    const ranked = money.paths.map((path): AnalysisPriority => {
        const expected = pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping: money.shipping, price }, config);
        const samples = path.compCount ?? 0;
        const compSupport = samples >= 3 && ["HIGH", "MEDIUM", "LOW"].includes(path.compConfidence ?? "")
            ? (path.compConfidence === "HIGH" ? 2 : path.compConfidence === "MEDIUM" ? 1 : 0) + (samples >= 10 ? 2 : 1)
            : 0;
        const asIs = path.path === "RAW" || path.path === "GRADED_RESALE";
        const floorNet = path.path === "RAW" && !listing.isGraded && money.rawFloorNet !== undefined ? Math.min(money.rawFloorNet, path.expectedNet)
            : path.path === "GRADED_RESALE" && samples >= 3 && ["HIGH", "MEDIUM"].includes(path.compConfidence ?? "") ? path.downsideNet : undefined;
        const conservative = floorNet === undefined ? null : pathNumbers({ expectedNet: floorNet, fixedCosts: path.fixedCosts, shipping: money.shipping, price }, config);
        const band = conservative?.clears ? 3 : asIs && expected.clears ? 2 : expected.clears ? 1 : 0;
        return { band, evidence: photoSupport + compSupport,
            conservativeProfit: conservative?.profit ?? null, expectedProfit: expected.profit, investment: expected.cost,
            reason: band === 3 ? "Targets fit a lower resale estimate; full photo verification is still required."
                : band === 2 ? "As-is resale estimate meets targets; photos must confirm the card and condition."
                : band === 1 ? "Profit depends on the grading estimate; photo assessment comes next."
                : unknown.reason };
    });
    return ranked.sort(comparePriority)[0] ?? unknown;
}

// A deterministic comparison avoids a huge optimistic ROI overwhelming
// stronger resale evidence. Lower capital breaks otherwise comparable ties.
export function comparePriority(a: AnalysisPriority, b: AnalysisPriority): number {
    return b.band - a.band || b.evidence - a.evidence ||
        (b.conservativeProfit ?? -Number.MAX_VALUE) - (a.conservativeProfit ?? -Number.MAX_VALUE) ||
        (b.expectedProfit ?? -Number.MAX_VALUE) - (a.expectedProfit ?? -Number.MAX_VALUE) ||
        (a.investment ?? Number.MAX_VALUE) - (b.investment ?? Number.MAX_VALUE);
}

export function compareAnalysisPriority(a: ListingSummary, b: ListingSummary, targets?: Targets): number {
    return Number(a.screen?.status === "DROPPED") - Number(b.screen?.status === "DROPPED") ||
        Number(Boolean(a.screen?.longShot)) - Number(Boolean(b.screen?.longShot)) || comparePriority(analysisPriority(a, targets), analysisPriority(b, targets)) || a.id.localeCompare(b.id);
}
