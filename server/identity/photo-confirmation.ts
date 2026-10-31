import type { PhotoCheck } from "../../shared/types.ts";
import type { PhotoInspection } from "../ai/photo-find.ts";
import { normalizeWords, photoPrinting, sameCardNumber, sameSetFamily, psaBaseLabelPrinting, type PhotoConfirmation } from "./card-identity.ts";

// A discovery scan alone cannot raise a valuation. Its independent reading
// must agree with the later full photo check, including actual front coverage.
export function confirmPhotoIdentity(scan: PhotoInspection | null, full: PhotoCheck, allowSlab = false): PhotoConfirmation | undefined {
    const a = scan?.card;
    const b = full.cardIdentity;
    if (!scan || !a || !b || scan.cardCount !== 1 || scan.isStockImage || full.cardCount !== "ONE" || full.holder === "GRADED_SLAB" && !allowSlab) return;
    if (allowSlab && full.slab?.present && (full.slab.authenticity !== "NONE_SEEN" || !full.slab.grader || !full.slab.grade)) return;
    if (a.confidence !== "HIGH" || b.confidence !== "HIGH" || !a.evidence.length || !b.evidence.length) return;
    if (!a.name || !a.set || !a.cardNumber || !b.name || !b.set || !b.cardNumber) return;
    if (normalizeWords(a.language) !== "english" || normalizeWords(b.language) !== "english") return;
    if (normalizeWords(a.name) !== normalizeWords(b.name) || !sameSetFamily(a.set, b.set) || !sameCardNumber(a.cardNumber, b.cardNumber)) return;
    if (!full.images.some((image) => image.view === "FRONT" && image.usable && !image.isStockImage)) return;
    if (full.printingMarks?.reprintMark !== "NONE_SEEN") return;
    if (/fake|proxy|counterfeit|replica|wrong fonts|off colo|blurry print|non.?standard|tamper|custom|reprint/i.test([...(full.cardMatch?.problems ?? []), ...full.problems].join(" "))) return;
    const shadowMatters = sameSetFamily(a.set, "Base Set");
    const first = photoPrinting(scan.printingMarks, { shadowMatters });
    const second = photoPrinting(full.printingMarks, { shadowMatters });
    return {
        name: b.name, set: b.set, cardNumber: b.cardNumber,
        finish: a.finish === b.finish && a.finish !== "UNKNOWN" ? a.finish : undefined,
        printing: psaBaseLabelPrinting(full.slab, b) ?? (first === second && first !== "UNKNOWN" ? first : undefined),
    };
}
