import type { Evaluation, ListingSummary, PhotoCardReading, SearchIntent } from "./types.ts";
import { finishClaim } from "./finish.ts";
import { isPrinting } from "./identity.ts";
import { setKey } from "./sets.ts";
import { explicitReprintSet } from "./reprint-release.ts";

type Finish = NonNullable<SearchIntent["finish"]>;
const GRADER = "(?:psa|cgc|bgs|sgc|tag)";
const GRADE = "(10|[1-9](?:\\.5)?)(?![\\d./])";
const textOf = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[–—]/g, "-");

export function finishIn(text: string): Finish | null {
    const finish = finishClaim(text);
    return finish === "NOT_STATED" || finish === "CONFLICTING" ? null : finish;
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

function searchSetFamily(value: string): string {
    // Preserve release names: Base Set 2 and Celebrations are never Base Set.
    if (/^\s*celebrations\s*:\s*classic collection\b/i.test(value)) return "celebrations";
    const key = setKey(value).replace(/\benglish\b/g, " ").replace(/\s+/g, " ").trim().replace(/^(?:19|20)\d{2}\s+/, "");
    if (/^(?:unknown|unspecified|not (?:known|stated|visible|specified)|n a)$/.test(key)) return "";
    if (key === "game") return "base set";
    if (/^game base set(?: 2)?$/.test(key)) return key.slice("game ".length);
    if (key === "rocket") return "team rocket";
    return key === "crown zenith galarian gallery" ? "crown zenith" : key;
}

function confirmedPhotoCard(evaluation: Evaluation): PhotoCardReading | null {
    const photo = evaluation.photoCheck?.cardIdentity;
    return photo?.confidence === "HIGH" && evaluation.photoCheck?.cardCount === "ONE" &&
        evaluation.photoCheck.images.some(image => image.usable && !image.isStockImage && (image.view === "FRONT" || image.view === "FRONT_DETAIL")) ? photo : null;
}

function numberMismatch(a: string | null | undefined, b: string | null | undefined): boolean {
    const parts = (value: string | null | undefined) => String(value ?? "").toUpperCase().replace(/\s|^#/g, "").split("/").map(part => {
        const match = part.match(/^([A-Z-]*?)0*(\d+)([A-Z]*)$/);
        return match ? `${match[1]}:${Number(match[2])}:${match[3]}` : null;
    });
    const x = parts(a), y = parts(b);
    return Boolean(x[0] && y[0] && (x[0] !== y[0] || x[1] && y[1] && x[1] !== y[1]));
}

// Seller metadata cannot keep a photo-identified wrong release in Review.
// Only settled facts exclude a copy; unclear photos remain an evidence gap.
export function evaluatedIdentityMismatch(evaluation: Evaluation, intent: SearchIntent): ListingSummary["match"] | null {
    const photo = confirmedPhotoCard(evaluation);
    const strongPhoto = Boolean(photo);
    const identified = evaluation.identity?.status === "IDENTIFIED" ? evaluation.identity : null;
    const card = photo ? { name: photo.name ?? identified?.name, set: photo.set ?? identified?.set, cardNumber: photo.cardNumber ?? identified?.cardNumber } : identified;
    const wantedSets = intent.sets.map(searchSetFamily).filter(Boolean);
    const cardSet = card?.set ? searchSetFamily(card.set) : "";
    if (cardSet && wantedSets.length && !wantedSets.includes(cardSet)) return "OTHER_SET";
    if (intent.cardNumber && numberMismatch(intent.cardNumber, card?.cardNumber)) return "OTHER_CARD";
    if (card?.name && !/^(?:unknown|not (?:known|visible|stated))$/i.test(card.name) && intent.titleWords.length) {
        const words = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const name = ` ${words(card.name)} `;
        if (intent.titleWords.some(word => !name.includes(` ${words(word)} `))) return "OTHER_CARD";
    }
    if (identified && intent.printing && isPrinting(identified.printing) && identified.printing !== intent.printing &&
        (!strongPhoto || !photo?.set || !identified.set || searchSetFamily(photo.set) === searchSetFamily(identified.set))) return "OTHER_PRINTING";
    // An explicit reprint title is enough to set aside a disputed Base Set
    // claim. It does not establish which anniversary issue it actually is.
    if (!cardSet && wantedSets.length && wantedSets.every(set => set === "base set") && explicitReprintSet(evaluation.listing.title)) return "OTHER_SET";
    return null;
}

export function evaluatedCriteriaMismatch(evaluation: Evaluation, intent: SearchIntent): boolean {
    if (evaluatedIdentityMismatch(evaluation, intent)) return true;
    const attributes = searchAttributes(evaluation.listing.title, evaluation.listing.aspects);
    const slab = evaluation.photoCheck?.slab;
    if (slab?.present) {
        attributes.grader = slab.grader?.toUpperCase() ?? null;
        attributes.grade = slab.grade && /^(?:10|[1-9](?:\.5)?)$/.test(slab.grade) ? +slab.grade : null;
    } else if (evaluation.photoCheck && intent.graded === true) {
        attributes.grader = null;
        attributes.grade = null;
    }
    const physicalFinish = confirmedPhotoCard(evaluation)?.finish;
    const finish = physicalFinish && physicalFinish !== "UNKNOWN" ? physicalFinish : finishIn(evaluation.identity?.finish ?? "");
    if (finish) attributes.finish = finish;
    else if (physicalFinish === "UNKNOWN") attributes.finish = null;
    return Boolean(criteriaMismatch(attributes, intent));
}

// Only an unknown criterion can be settled here; explicit mismatches remain
// excluded. A predicted raw grade never substitutes for a read slab label.
export function withResolvedCriteria(listing: ListingSummary, evaluation: Evaluation | undefined, intent: SearchIntent | undefined): ListingSummary {
    return listing.match === "UNCONFIRMED_CRITERIA" && evaluation?.identity?.status === "IDENTIFIED" && !evaluation.identity.notThisCard && intent && !evaluatedCriteriaMismatch(evaluation, intent)
        ? { ...listing, match: undefined } : listing;
}

export function describeSearchCriteria(intent: SearchIntent): string[] {
    const grades = intent.minGrade != null || intent.maxGrade != null;
    const range = !grades ? "" : intent.minGrade === intent.maxGrade ? `${intent.minGrade}` : intent.maxGrade === 10 ? `${intent.minGrade ?? 1}+` : `${intent.minGrade ?? 1}–${intent.maxGrade ?? 10}`;
    return [intent.grader ? `${intent.grader}${range ? ` ${range}` : ""}` : grades ? `Grade ${range}` : intent.graded === null ? "" : intent.graded ? "Graded" : "Raw",
        intent.finish === "HOLO" ? "Holo" : intent.finish === "REVERSE_HOLO" ? "Reverse holo" : intent.finish === "NON_HOLO" ? "Non-holo" : ""].filter(Boolean);
}
