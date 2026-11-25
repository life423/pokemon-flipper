import { normalizeText } from "../ebay/filters.ts";
import { sameCardNumber } from "../../shared/card-number.ts";

// Catalog artwork/finish labels describe a numbered card rather than changing
// its printed name. Keep this suffix list explicit: unknown residual words,
// owners and forms must still fail an exact comparison.
const DESCRIPTIVE_SUFFIX = /(?:^|\s)(?:(?:(?:reverse|rev|non)\s*)?(?:holo(?:graphic|foil)?|foil)|(?:alternate|alt)(?:\s+full)?\s+art|full\s+art)$/;
// PKMNPrices appends these rarity/artwork labels to numbered modern cards.
// Require the parenthetical catalog suffix: an unbracketed Secret or other
// unknown wording may belong to the printed name and must stay distinct.
const CATALOG_RARITY_SUFFIX = /\s+\((?:(?:(?:alternate|alt)(?:\s+full)?\s+art\s+)?secret|secret\s+shining)\)\s*$/i;

// Some Plasma Blast catalog products append the faction and the full-art
// collector number to the printed EX name. Bind that number to the record
// before comparing names; the regular artwork has its own collector number.
export function catalogPrintedName(name: string, set: string | null | undefined, number: string): string {
    if (typeof name !== "string" || typeof set !== "string" || set.trim().toLowerCase() !== "plasma blast") return name;
    const label = /^(.+?[- ]EX) \(Team Plasma\) \((\d{1,4}) Full Art\)$/i.exec(name.trim());
    const collector = /^(\d{1,4})(?:\/\d{1,4})?$/.exec(String(number).trim());
    return label && collector && Number(label[2]) === Number(collector[1]) ? label[1]! : name;
}

// These provider labels distinguish the numbered holo records from the ordinary
// cards with the same printed name. Keep the native labels for stored evidence
// and collapse them only for name comparisons inside their verified market.
export function numberedCatalogName(name: unknown, set: unknown, number: unknown): string {
    if (typeof name !== "string") return "";
    if (typeof set !== "string" || typeof number !== "string") return name;
    if (!["aquapolis", "skyridge"].includes(set.trim().toLowerCase())) return name;
    const label = /^(.+?)\s+\((H(?:0?[1-9]|[12]\d|3[0-2]))\)$/i.exec(name.trim());
    if (!label || !/^#?H\d{1,2}(?:\s*\/\s*H32)?$/i.test(number.trim()) || !sameCardNumber(label[2], number)) return name;
    return label[1];
}

export function sameNumberedCatalogName(left: unknown, right: unknown, set: unknown, number: unknown): boolean {
    const a = numberedCatalogName(left, set, number), b = numberedCatalogName(right, set, number);
    return sameCatalogName(a, b) || Boolean(set && typeof number === "string" && number.includes("/") &&
        (symbolSexName(a) && sexAbbreviation(b, a) || symbolSexName(b) && sexAbbreviation(a, b)));
}

const symbolSexName = (name: string) => /[♀♂]\s*$/.test(name);

function sexAbbreviation(claim: string, printed: string) {
    const sex = /^(.+) (male|female)$/.exec(canonicalCatalogName(printed));
    const short = canonicalCatalogName(claim);
    return Boolean(sex && (short === `${sex[1]} ${sex[2][0]}` || short === `${sex[1]}${sex[2][0]}`));
}

// Only positive same-record results may reuse a shorter cached search.
export function catalogQueryAlias(name: string): string | null {
    const words = canonicalCatalogName(name);
    if (symbolSexName(name)) return words.replace(/(male|female)$/, sex => sex[0]);
    return /^(.+) 0[1-9]$/.exec(words)?.[1] ?? null;
}

// Use only with an independently read full collector fraction and a matching
// catalog record. The printed name remains the lookup key.
export function sellerNameMatchesPrint(claim: string | null | undefined, printed: string, number: string): boolean {
    if (!claim) return false;
    if (sameCatalogName(claim, printed)) return true;
    const short = canonicalCatalogName(claim);
    const name = canonicalCatalogName(printed);
    if (symbolSexName(printed) && sexAbbreviation(claim, printed)) return true;
    const printedPart = /^(.+) 0[1-9]$/.exec(name);
    if (printedPart?.[1] === short) return true;
    const collector = /^(.+?)\s+\(([a-z]{0,5}\d{1,4}[a-z]?)\)$/i.exec(claim.trim());
    return Boolean(collector && sameCardNumber(collector[2], number) && sameCatalogName(collector[1], printed));
}

export function canonicalCatalogName(value: unknown): string {
    let name = normalizeText(String(value ?? "").replace(CATALOG_RARITY_SUFFIX, "").replace(/[‘’]/g, "'")
        .replace(/♀/g, " female ").replace(/♂/g, " male ")
        .replace(/[★☆]/g, " star ").replace(/δ/gi, " delta "))
        // Apostrophes are part of printed owners and names, including
        // Blaine's Arcanine and Farfetch'd. Other punctuation is spacing.
        .replace(/[^a-z0-9']+/g, " ").trim();
    for (;;) {
        const shorter = name.replace(DESCRIPTIVE_SUFFIX, "").trim();
        if (shorter === name) return name;
        name = shorter;
    }
}

export function sameCatalogName(left: unknown, right: unknown): boolean {
    const name = canonicalCatalogName(left);
    return Boolean(name) && name === canonicalCatalogName(right);
}
