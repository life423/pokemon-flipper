import type { PhotoCardReading, PhotoCheck } from "./types.ts";

type LabelPhotos = Partial<Pick<PhotoCheck, "cardIdentity" | "slab" | "holder" | "cardCount" | "cardMatch" | "images" | "printedName" | "printedNumber">>;
const numberThree = /^#?0*3\s*\/\s*110$/i;

// PSA's 2002 Legendary Collection guide lists #3 under three distinct subjects:
// Charizard (the non-holo Lava deck copy), Charizard-Holo and Charizard-Reverse Foil.
// https://www.psacard.com/priceguide/non-sports-tcg-card-values/2002-poke-mon-legendary-collection/3906
export function legendaryCharizardLabelFinish(check?: LabelPhotos | null): PhotoCardReading["finish"] | null {
    const card = check?.cardIdentity, slab = check?.slab;
    if (!card || check?.holder !== "GRADED_SLAB" || !slab?.present || slab.grader?.toUpperCase() !== "PSA" ||
        card.name?.trim().toLowerCase() !== "charizard" || card.set?.trim().toLowerCase() !== "legendary collection" ||
        !numberThree.test(card.cardNumber ?? "")) return null;
    if (card.confidence !== "HIGH" || check.cardCount !== "ONE" || check.cardMatch?.verdict !== "MATCH" || slab.holderConflict ||
        slab.authenticity !== "NONE_SEEN" || slab.gradeQualifier || !/^(?:10|[1-9](?:\.5)?)$/.test(slab.grade ?? "") ||
        !/^\d{8,9}$/.test(slab.certNumber ?? "") || !/^english$/i.test(card.language ?? "") ||
        check.printedName?.trim().toLowerCase() !== "charizard" || !numberThree.test(check.printedNumber ?? "") ||
        !check.images?.some(photo => photo.view === "FRONT" && photo.usable && !photo.isStockImage)) return "UNKNOWN";

    const label = (slab.labelText ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
        .replace(/[\s,;:|/–—-]+/g, " ").trim();
    // Match only complete transcriptions. The grade, certificate and #3 may
    // appear alongside the left-hand lines on row-by-row transcriptions.
    const left = label.replace(/#\s*0*3\b/, " ").replace(/\b\d{8,9}\b/, " ").replace(/\s+/g, " ").trim();
    if (!/#\s*0*3\b/.test(label) || label.match(/\b\d{8,9}\b/)?.[0] !== slab.certNumber) return "UNKNOWN";
    const grade = left.match(/\b(?:GEM M(?:IN)?T|NM MT|EX MT|VG EX|MINT|NM|EX|VG|GOOD|FAIR|FR|POOR|PR)\s+(10|[1-9](?:\.5)?)\b/);
    if (!grade || grade[1] !== slab.grade) return "UNKNOWN";
    const subject = left.replace(grade[0], " ").replace(/\bLEGENDARY COLLECTION\b/, " ").replace(/\s+/g, " ").trim();
    if (!/\bLEGENDARY COLLECTION\b/.test(left)) return "UNKNOWN";
    switch (subject) {
        case "2002 POKEMON CHARIZARD": return "NON_HOLO";
        case "2002 POKEMON CHARIZARD HOLO": return "HOLO";
        case "2002 POKEMON CHARIZARD REVERSE FOIL": return "REVERSE_HOLO";
        default: return "UNKNOWN";
    }
}

export function legendaryCharizardFinishNote(finish: PhotoCardReading["finish"]): string {
    if (finish === "UNKNOWN") return "The PSA label for Legendary Collection Charizard #3 does not establish which finish this copy has. Holo and reverse-foil resale prices are excluded.";
    if (finish === "NON_HOLO") return "The PSA label reads Charizard. For Legendary Collection #3, that identifies the non-holo Lava theme deck copy.";
    return "The PSA label identifies Legendary Collection Charizard #3 as " + (finish === "HOLO" ? "holo." : "reverse foil.");
}
