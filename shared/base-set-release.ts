import { normalizeCardNumber } from "./card-number.ts";
import { normalizedPhoto } from "./listing-evidence.ts";
import { setKey } from "./sets.ts";
import type { Evaluation } from "./types.ts";

export interface ReleaseMarkReading {
    mark: "PIKACHU_25" | "OTHER_MARK" | "CLEAR" | "UNCLEAR";
    observation: string;
    gallery: string;
    photoNumber: number;
    sourceSha256: string;
}

const legacyPending = "The anniversary stamp area on the original front still needs verification before Base Set sales can price this copy.";
const pending = "The original Base Set printing is unconfirmed, so its resale value is uncertain.";

export function isPendingReleaseReason(reason: string) {
    return reason === pending || reason === legacyPending;
}

export function needsReleaseReading(e: Evaluation) {
    return baseSetLookalike(e) && !e.identity?.notThisCard && !currentReleaseReading(e) &&
        (e.identity?.status === "IDENTIFIED" || e.identity?.reasons.some(isPendingReleaseReason));
}

// These four English Base Set cards were reproduced with their original numbers
// in the 2021 Classic Collection. Matching the number and artwork is insufficient.
export function baseSetLookalike(e: Evaluation) {
    const id = e.identity;
    const number = normalizeCardNumber(id?.cardNumber);
    return !!(id?.set && /^(?:(?:1999|2000) )?(?:game )?base(?: set)?$/.test(setKey(id.set)) && number?.number && !number.numberPrefix &&
        [2, 4, 15, 73].includes(number.number) && (number.total === null || number.total === 102) &&
        !e.slab && e.photoCheck?.holder !== "GRADED_SLAB");
}

export function releaseGalleryKey(e: Evaluation): string {
    // Photo numbers refer to positions, including repeated images.
    return JSON.stringify((e.listing.photos ?? []).map(normalizedPhoto));
}

export function currentReleaseReading(e: Evaluation, r = e.releaseMark): ReleaseMarkReading | undefined {
    if (!r || !["PIKACHU_25", "OTHER_MARK", "CLEAR", "UNCLEAR"].includes(r.mark) ||
        typeof r.observation !== "string" || !r.observation.trim() || r.observation.length > 1000 ||
        !Number.isSafeInteger(r.photoNumber) || !/^[a-f0-9]{64}$/.test(r.sourceSha256) ||
        !e.listing.photos?.[r.photoNumber - 1] || r.gallery !== releaseGalleryKey(e)) return;
    if (e.photoCheck?.images.some(p => p.number === r.photoNumber && p.view === "FRONT" && p.usable && !p.isStockImage)) return r;
}

export function releaseIssue(e: Evaluation): string | undefined {
    if (!baseSetLookalike(e)) return;
    const r = currentReleaseReading(e);
    if (!r) return pending;
    if (r.mark === "CLEAR") return;
    const source = `Photo ${r.photoNumber}`;
    if (r.mark === "PIKACHU_25") return `${source} shows the Pikachu 25th anniversary stamp from the 2021 Celebrations release. Base Set prices do not apply.`;
    if (r.mark === "OTHER_MARK") return `${source} shows a different release mark. ${r.observation}`;
    return `${source} does not resolve the release mark. ${r.observation}`;
}

// Project current advice without modifying the saved assessment or its prices.
export function withReleaseEvidence(e: Evaluation): Evaluation {
    const reason = releaseIssue(e), id = e.identity;
    if (!reason || !id || id.notThisCard || id.status !== "IDENTIFIED" && !id.reasons.some(isPendingReleaseReason)) return e;
    const reading = currentReleaseReading(e);
    const marked = reading?.mark === "PIKACHU_25" || reading?.mark === "OTHER_MARK";
    const set = reading?.mark === "PIKACHU_25" ? "Celebrations: Classic Collection" : null;
    const notes = marked ? [`Photo ${reading.photoNumber}: ${reading.observation}`] : [];
    const check = e.photoCheck;
    return { ...e, identity: { ...id, status: "NEEDS_REVIEW",
        ...(marked && { notThisCard: reason, recordId: null, printing: "UNKNOWN", printingLabel: null,
            set, evidence: id.evidence && { ...id.evidence, photo: "UNKNOWN", photoNotes: notes } }),
        reasons: [...new Set([reason, ...id.reasons.filter(r => !isPendingReleaseReason(r))])] },
        ...(marked && check && { photoCheck: { ...check, cardMatch: { verdict: "MISMATCH", problems: [reason] },
            cardIdentity: check.cardIdentity && { ...check.cardIdentity, set, evidence: notes },
            printingMarks: check.printingMarks && { ...check.printingMarks,
                reprintMark: set ? "CELEBRATIONS_25TH" : "OTHER_STAMP", evidence: notes } } }),
        rawPricing: null, gradedPricing: null, slabPricing: null, underwriting: null, rating: null,
        marketActivity: undefined, trackerRawReference: undefined, trackerPriceReference: undefined, webPriceResearch: undefined };
}
