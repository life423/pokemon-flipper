import type { Evaluation, ListingSummary } from "./types.ts";

export type CardLanguageStatus = "ENGLISH" | "OTHER" | "UNKNOWN";
export class EnglishOnlyError extends Error {
    constructor() { super("This app currently searches and evaluates English cards only. This search or listing identifies a different card language."); }
}
const OTHER = /\b(japanese|japan|jpn|jp|korean|chinese|german|french|italian|spanish|portuguese|dutch|thai|indonesian|russian|polish|multilingual)\b/i;
const OTHER_CODE = /^(ja|jpn|jp|ko|kor|zh|chs|cht|de|ger|deu|fr|fre|fra|it|ita|es|spa|pt|por|nl|dut|nld|th|tha|id|ind|ru|rus|pl|pol)(?:[-_][a-z]{2,4})?$/i;
const ENGLISH = /\benglish\b|^\s*(en|eng)(?:[-_](?:us|gb))?\s*$/i;
const UNKNOWN = /^(unknown|not (?:known|stated|specified|visible)|unspecified|uncertain|n\/?a|undetermined)$/i;

// Unknown language needs identification; it is not evidence of a foreign card.
// Explicit conflicting languages stay excluded, including stale saved readings.
export function cardLanguageStatus(title: string, languages: readonly (string | null | undefined)[] = []): CardLanguageStatus {
    const stated = languages.map(value => value?.trim()).filter((value): value is string => Boolean(value) && !UNKNOWN.test(value!));
    if (OTHER.test(title) || stated.some(value => OTHER.test(value) || OTHER_CODE.test(value) || !ENGLISH.test(value))) return "OTHER";
    return stated.some(value => ENGLISH.test(value)) || /\b(english|eng)\b/i.test(title) ? "ENGLISH" : "UNKNOWN";
}

export function englishListingEligible(listing: Pick<ListingSummary, "title" | "screen" | "match">, evaluation?: Evaluation | null): boolean {
    return listing.match !== "OTHER_LANGUAGE" && cardLanguageStatus(listing.title, [
        evaluation?.listing?.aspects?.Language,
        evaluation?.identity?.language,
        evaluation?.photoCheck?.cardIdentity?.language,
    ]) !== "OTHER" && (!evaluation || cardLanguageStatus(evaluation.listing.title) !== "OTHER");
}
