import type { Evaluation, ListingSummary, SearchIntent } from "./types.ts";

type Finish = NonNullable<SearchIntent["finish"]>;
const GRADER = "(?:psa|cgc|bgs|sgc|tag)";
const GRADE = "(10|[1-9](?:\\.5)?)(?![\\d./])";
const textOf = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[–—]/g, "-");

export function finishIn(text: string): Finish | null {
    const value = textOf(text).replace(/_/g, " ");
    if (/\bnon[ -]?(?:holo(?:graphic)?s?|foils?)\b/.test(value)) return "NON_HOLO";
    if (/\b(?:reverse[ -]?(?:holo(?:graphic)?s?|foils?)?|rh)\b/.test(value)) return "REVERSE_HOLO";
    return /\b(?:holo(?:graphic)?s?|foils?)\b/.test(value) ? "HOLO" : null;
}

// Reliable common operators still work if the language-model request fails.
export function explicitCriteria(search: string): Pick<SearchIntent, "grader" | "minGrade" | "maxGrade" | "finish"> {
    const text = textOf(search);
    const grader = text.match(new RegExp(`\\b${GRADER}(?=\\b|\\d)`, "i"))?.[0].toUpperCase() ?? null;
    const anchor = `(?:${GRADER}|grades?|graded)\\s*(?:grades?\\s*)?`;
    const range = text.match(new RegExp(`\\b${anchor}(?:between\\s+)?${GRADE}\\s*(?:to|through|and|-)\\s*${GRADE}`));
    if (range) return { grader, minGrade: Math.min(+range[1], +range[2]), maxGrade: Math.max(+range[1], +range[2]), finish: finishIn(text) };
    const single = text.match(new RegExp(`\\b(?:(at least|minimum|min|at most|maximum|max)\\s+)?${anchor}(?:(at least|minimum|min|at most|maximum|max)\\s+)?${GRADE}(\\s*(?:\\+|or (?:better|higher|above|lower|less)|and (?:up|above)|and (?:under|below)))?`));
    if (!single) return { grader, minGrade: null, maxGrade: null, finish: finishIn(text) };
    const grade = +single[3];
    const operator = `${single[1] ?? ""} ${single[2] ?? ""} ${single[4] ?? ""}`;
    const lower = /least|minimum|\bmin\b|\+|better|higher|above|\bup\b/.test(operator);
    const upper = /most|maximum|\bmax\b|lower|less|under|below/.test(operator);
    return { grader, minGrade: upper ? 1 : grade, maxGrade: lower ? 10 : grade, finish: finishIn(text) };
}

export function fallbackKeywords(search: string): string {
    return search.toLowerCase()
        .replace(new RegExp(`\\b(?:(?:at least|minimum|min|at most|maximum|max)\\s+)?(?:${GRADER}|grades?|graded)\\s*(?:grades?\\s*)?(?:(?:at least|at most|minimum|maximum|between)\\s+)?${GRADE}(?:\\s*(?:to|through|and|-)\\s*${GRADE}|\\s*(?:\\+|or (?:better|higher|above|lower|less)|and (?:up|above|under|below)))?`, "gi"), " ")
        .replace(/\b(?:can you|could you|show me|find me|i want|i am looking for|looking for|please|some|any|all|cards?|graded|grading|copies|from|with|the|by)\b/gi, " ")
        .replace(/\s+/g, " ").trim();
}

export function marketplaceQuery(search: string, intent: SearchIntent): string {
    let words = fallbackKeywords(intent.keywords || search);
    // Never turn a range into an exact-grade eBay keyword search.
    words = words.replace(new RegExp(`\\b${GRADER}\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
    return [words, intent.grader || (intent.graded === true ? "graded" : null), intent.grader && intent.minGrade != null && intent.minGrade === intent.maxGrade ? intent.minGrade : null].filter((v) => v !== null && v !== undefined && v !== "").join(" ").slice(0, 300) || search;
}

export interface SearchAttributes { grader: string | null; grade: number | null; finish: Finish | null }
export function searchAttributes(title: string, aspects: Record<string, string> = {}): SearchAttributes {
    const fromTitle = textOf(title).match(new RegExp(`\\b(${GRADER})\\s*(?:(?:gem|mint|mt|nm|near|ex|excellent|vg|very|good|poor|fair|pristine|black|label)[ -]+){0,5}${GRADE}`, "i"));
    const specificGrader = (aspects["Professional Grader"] ?? "").match(new RegExp(`\\b${GRADER}\\b`, "i"))?.[0].toUpperCase() ?? null;
    const specificGrade = (aspects.Grade ?? "").match(new RegExp(`\\b${GRADE}`));
    return { grader: specificGrader ?? fromTitle?.[1].toUpperCase() ?? null,
        grade: specificGrade ? +specificGrade[1] : fromTitle ? +fromTitle[2] : null,
        finish: /^(regular|normal)$/i.test(aspects.Finish ?? "") ? "NON_HOLO" : finishIn(aspects.Finish ?? "") ?? finishIn(title) };
}

export function criteriaMismatch(attributes: SearchAttributes, intent: SearchIntent, requireKnown = true): ListingSummary["match"] | null {
    if (intent.grader && attributes.grader && attributes.grader !== intent.grader) return "OTHER_GRADER";
    if (attributes.grade !== null && (intent.minGrade != null && attributes.grade < intent.minGrade || intent.maxGrade != null && attributes.grade > intent.maxGrade)) return "OTHER_GRADE";
    if (intent.finish && attributes.finish && attributes.finish !== intent.finish) return "OTHER_FINISH";
    if (requireKnown && (intent.grader && !attributes.grader || (intent.minGrade != null || intent.maxGrade != null) && attributes.grade === null || intent.finish && !attributes.finish)) return "UNCONFIRMED_CRITERIA";
    return null;
}

export function evaluatedCriteriaMismatch(evaluation: Evaluation, intent: SearchIntent): boolean {
    const attributes = searchAttributes(evaluation.listing.title, evaluation.listing.aspects);
    const slab = evaluation.photoCheck?.slab;
    if (slab?.present) {
        attributes.grader = slab.grader?.toUpperCase() ?? null;
        attributes.grade = slab.grade && /^(?:10|[1-9](?:\.5)?)$/.test(slab.grade) ? +slab.grade : null;
    } else if (evaluation.photoCheck && intent.graded === true) {
        attributes.grader = null;
        attributes.grade = null;
    }
    const finish = finishIn(evaluation.identity?.finish ?? "");
    if (finish) attributes.finish = finish;
    return Boolean(criteriaMismatch(attributes, intent));
}

export function describeSearchCriteria(intent: SearchIntent): string[] {
    const grades = intent.minGrade != null || intent.maxGrade != null;
    const range = !grades ? "" : intent.minGrade === intent.maxGrade ? `${intent.minGrade}` : intent.maxGrade === 10 ? `${intent.minGrade ?? 1}+` : `${intent.minGrade ?? 1}–${intent.maxGrade ?? 10}`;
    return [intent.grader ? `${intent.grader}${range ? ` ${range}` : ""}` : grades ? `Grade ${range}` : intent.graded === null ? "" : intent.graded ? "Graded" : "Raw",
        intent.finish === "HOLO" ? "Holo" : intent.finish === "REVERSE_HOLO" ? "Reverse holo" : intent.finish === "NON_HOLO" ? "Non-holo" : ""].filter(Boolean);
}
