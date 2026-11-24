import { cardLanguageStatus } from "./card-language.ts";
import { normalizeCardNumber } from "./card-number.ts";
import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { unsupportedVariantReason } from "./money/price-evidence.ts";
import { slabLabelConfidence } from "./photo-evidence.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import { setKey } from "./sets.ts";
import type { Evaluation } from "./types.ts";

// Compare ordinary, photo-identified slabs in the same certified market.
export function verifiedSlabMarketKey(value: Evaluation, { allowScratchedCase = false } = {}): string | null {
    const { identity, slab, photoCheck, listing } = value;
    const number = normalizeCardNumber(identity?.cardNumber);
    if (!identity?.name || !identity.set || number?.number == null || !slab?.grader || !slab.grade ||
        !slabLabelConfidence(value) || !["HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(identity.finish) ||
        cardLanguageStatus("", [identity.language, photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        cardLanguageStatus(listing.title, [listing.aspects.Language]) === "OTHER" ||
        slab.gradeQualifier || photoCheck?.slab?.gradeQualifier || hasSpecialSlabTitle(listing.title) ||
        unsupportedVariantReason(value) || hasBaseSetFourthPrint(identity.set, listing.title, slab.labelText) ||
        !(slab.caseCondition === "INTACT" && photoCheck?.slab?.caseCondition === "INTACT" ||
            allowScratchedCase && slab.caseCondition === "SCRATCHED" && photoCheck?.slab?.caseCondition === "SCRATCHED") || !/^(?:10|[1-9](?:\.5)?)$/.test(slab.grade)) return null;
    return JSON.stringify([identity.name.trim().toLowerCase(), setKey(identity.set), number, identity.printing,
        identity.finish, slab.grader, Number(slab.grade)]);
}
