import type { RawCondition } from "./conditions.ts";
import type { ListingSummary } from "./types.ts";

const PHRASE = "(?:near[ -]?mint|lightly[ -]?played|moderately[ -]?played|heavily[ -]?played|mint|nm|lp|mp|hp|dmg|damaged)";
const questioned = () => new RegExp(`\\b${PHRASE}\\s*\\?`, "gi");

// A seller's words only: this never establishes the photographed condition.
// In particular, HP can be a condition after a collector number, while 120 HP
// and HP 120 describe hit points. Keep explicit #/fraction collector numbers.
function withoutHitPoints(title: string): string {
    return title.replace(/\bhp\s*\d{1,3}\b(?!\s*\/)/gi, " ").replace(/\b\d{1,3}\s*hp\b/gi, (match, offset: number, text: string) => {
        const before = text.slice(0, offset).trimEnd();
        return /[/#]$/.test(before) ? match : " ";
    });
}

function conditionClaims(title: string): RawCondition[] {
    const text = withoutHitPoints(title);
    const patterns: [RawCondition, RegExp][] = [
        ["NEAR_MINT", /\bnear[ -]?mint\b|\bnm\b/i],
        ["MINT", /\bmint\b/i],
        ["LIGHTLY_PLAYED", /\blightly[ -]?played\b|\blp\b/i],
        ["MODERATELY_PLAYED", /\bmoderately[ -]?played\b|\bmp\b/i],
        ["HEAVILY_PLAYED", /\bheavily[ -]?played\b|\bhp(?=\b|[a-z]{0,5}\d{1,4}[a-z]?\s*\/)/i],
        ["DAMAGED", /\bdamaged\b|\bdmg\b/i],
    ];
    const matches = patterns.filter(([condition, pattern]) => pattern.test(condition === "MINT" ? text.replace(/\bnear[ -]?mint\b/gi, " ") : text));
    return matches.map(([condition]) => condition);
}

export function rawConditionClaim(title: string): RawCondition | null {
    if (questioned().test(title)) return null;
    const matches = conditionClaims(title);
    return matches.length === 1 ? matches[0] : null;
}

export interface SellerConditionClues {
    // Only an agreeing seller claim, never an assessed physical condition.
    claim: RawCondition | null;
    conflict: boolean;
    ambiguous: boolean;
    severe: boolean;
}

const HOLDER = "(?:slab|case|holder|sleeve|top[ -]?loader|packaging|box)";
function cardClaimText(text: string, note: boolean): string {
    return text.split(/[;.,\n]|\b(?:but|while|however)\b/i).flatMap(clause => {
        // A scratched/damaged case is not a raw-card condition. Keep separate
        // explicit card statements, including 'damaged card in a sleeve'.
        if (note && new RegExp(`\\b${HOLDER}\\b`, "i").test(clause) && !/\b(?:card|copy)\b/i.test(clause)) return [];
        return [clause.replace(new RegExp(`\\b${PHRASE}\\s+${HOLDER}\\b`, "gi"), " ")
            .replace(new RegExp(`\\b${HOLDER}\\s+(?:(?:is|was|looks|appears)\\s+)?${PHRASE}\\b`, "gi"), " ")];
    }).join(" ").replace(new RegExp(`\\b(?:not|no|without|never)\\s+(?:(?:any|a|an|signs? of|evidence of)\\s+)*${PHRASE}(?:\\s*[-/]\\s*${PHRASE})*\\b`, "gi"), " ");
}

// Listing-only research clues. Keep this separate from sold-copy condition
// classification so metadata aliases/notes cannot change accepted sold prices.
export function sellerConditionClues(listing: Pick<ListingSummary, "title" | "cardCondition" | "conditionNotes">): SellerConditionClues {
    const metadata = listing.cardCondition?.replace(/_/g, " ").replace(/\bexcellent\b/gi, "Lightly Played").trim();
    const conditionField = metadata && /^(?:poor|very good)$/i.test(metadata)
        ? /^poor$/i.test(metadata) ? "Heavily Played" : "Moderately Played" : metadata;
    const sources = [{ text: listing.title, note: false }, { text: conditionField, note: false },
        ...(listing.conditionNotes ?? []).map(text => ({ text, note: true }))].filter((source): source is { text: string; note: boolean } => Boolean(source.text?.trim()));
    const claims = new Set<RawCondition>();
    let ambiguous = false;
    for (const source of sources) {
        const text = cardClaimText(source.text, source.note);
        if (questioned().test(text)) ambiguous = true;
        // A questioned category supplies no positive condition claim, while a
        // separate explicit HP/damage statement still warrants research caution.
        const found = conditionClaims(text.replace(questioned(), " "));
        if (found.length > 1) ambiguous = true;
        for (const claim of found) claims.add(claim);
    }
    const conflict = claims.size > 1;
    return { claim: claims.size === 1 && !ambiguous ? [...claims][0] : null, conflict, ambiguous: ambiguous || conflict,
        severe: claims.has("DAMAGED") || claims.has("HEAVILY_PLAYED") };
}
