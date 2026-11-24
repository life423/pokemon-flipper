import { cardLanguageStatus } from "../../shared/card-language.ts";
import { sameCardNumber } from "../../shared/card-number.ts";
import { finishClaim } from "../../shared/finish.ts";
import { gradeQualifier, hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import type { ScreeningSoldReference } from "../../shared/types.ts";
import type { ListingDetails } from "../ebay/listings.ts";
import { cardNumberIn, normalizeSetName, normalizeWords, printingClaimFromText, titleContradiction } from "./card-identity.ts";
import { sameCatalogName } from "./catalog-name.ts";
import { hasGalleryNumber } from "./screening-name.ts";

const gallerySet = (set: string | undefined) => ["crown zenith", "crown zenith galarian gallery"].includes(normalizeSetName(set));
export const isSv151Set = (set: string | undefined) => ["scarlet violet 151", "scarlet and violet 151", "mew en 151", "151"].includes(normalizeSetName(set));
const labelNamePrefix = /^(?:FA|FULL ART)\s*\/\s*/i;
const certPattern = /^\d{8,9}$/;
// A label-only check cannot assess disclosed damage or authenticate a holder.
const damageMention = /\b(?:cracks?|cracked|chipped|broken|tampered|counterfeit|resealed|damaged|scratched|scratches)\b/i;

function ordinaryHoloClaims(text: string, reference: ScreeningSoldReference): boolean {
    const finish = finishClaim(text), printing = printingClaimFromText(text);
    return !hasSpecialSlabTitle(text) && !titleContradiction(text, reference.set, reference.cardNumber) &&
        !/\b(?:world championships?|stamped|CGC|BGS|SGC|TAG)\b/i.test(text) &&
        (finish === "NOT_STATED" || finish === reference.finish) &&
        (printing === "NOT_STATED" || printing === reference.printing);
}

// Read only PSA label layouts with an independently identifiable English card face.
export function canMatchLabelText({ title, aspects, condition, conditionNotes }: ListingDetails, reference: ScreeningSoldReference): boolean {
    const grade = reference.grade;
    const gallery = gallerySet(reference.set) && hasGalleryNumber(reference.cardNumber) && /\/GG70$/i.test(reference.cardNumber) &&
        / VSTAR$/i.test(reference.name) && gallerySet(aspects.Set);
    const sv151 = isSv151Set(reference.set) && /^\d{3}\/165$/.test(reference.cardNumber) && Number(reference.cardNumber.split("/")[0]) > 165 &&
        isSv151Set(aspects.Set);
    if (!grade || reference.grader !== "PSA" || !reference.soleCatalogVariant || reference.finish !== "HOLO" || reference.printing !== "UNLIMITED" ||
        !(gallery || sv151) || condition !== "Graded" ||
        /^no$/i.test(aspects.Graded ?? "") || !certPattern.test(aspects["Certification Number"] ?? "") ||
        [title, ...(conditionNotes ?? [])].some(claim => damageMention.test(claim))) return false;

    const sellerGrade = searchAttributes("", aspects);
    const titleGrade = searchAttributes(title);
    const sellerName = aspects["Card Name"]?.replace(labelNamePrefix, "");
    const titleNumber = cardNumberIn(title);
    const titleWords = ` ${normalizeWords(title)} `;
    if (sellerGrade.grader !== "PSA" || sellerGrade.grade !== Number(grade) ||
        (titleGrade.grader && titleGrade.grader !== "PSA") || (titleGrade.grade !== null && titleGrade.grade !== Number(grade)) ||
        !sameCatalogName(sellerName, reference.name) || !sameCardNumber(aspects["Card Number"], reference.cardNumber) ||
        !titleWords.includes(` ${normalizeWords(reference.name)} `) ||
        (titleNumber && !sameCardNumber(titleNumber, reference.cardNumber)) ||
        cardLanguageStatus(title, [aspects.Language]) === "OTHER") return false;

    const claimedGrade = aspects.Grade?.replace(/^\s*\d+(?:\.\d+)?\s*[-–—:]*\s*/, "").replace(/^\((.*)\)$/, "$1");
    if ([claimedGrade, aspects["Grade Qualifier"], aspects["Grade Designation"]].some(value => gradeQualifier(value, "PSA", grade))) return false;
    const claims = [title, aspects.Set, aspects.Finish, aspects.Edition, aspects.Features, aspects.Printing].filter(Boolean).join(" ");
    return ordinaryHoloClaims(claims, reference) && ["HOLO", "NOT_STATED"].includes(finishClaim(aspects.Finish)) &&
        !/\bPSA\s*\d+(?:\.\d+)?[\s–—-]+(?:OC|MK|MC|ST|PD|OF)\b/i.test(title);
}

// Require a single contiguous label, then corroborate it with the collector
// fraction and two portions of English card text below the label. A seller's
// missing language field or a number on the label alone cannot establish this.
export function matchesLabelText(lines: readonly string[], listing: ListingDetails, reference: ScreeningSoldReference): boolean {
    if (!canMatchLabelText(listing, reference)) return false;
    const text = lines.map(line => line.trim().replace(/\s+/g, " ")).filter(Boolean);
    const sv151 = isSv151Set(reference.set);
    const header = sv151 ? "2023 POKEMON MEW EN" : "2023 POKEMON SWSH";
    const first = text.findIndex(line => line.toUpperCase() === header);
    if (first < 0 || text.filter(line => certPattern.test(line)).length !== 1) return false;

    const [name, set, number, description, grade, cert] = text.slice(first + 1, first + 7);
    if (cert !== listing.aspects["Certification Number"] || grade !== reference.grade ||
        !description || /^(?:none|n\/a|null)$/i.test(description) || gradeQualifier(description, "PSA", reference.grade) ||
        !sameCardNumber(number, reference.cardNumber) || !sameCatalogName(name?.replace(labelNamePrefix, ""), reference.name)) return false;
    if (sv151 ? set?.toUpperCase() !== "ILLUSTRATION RARE" || !/^#\s*\d{3}$/.test(number ?? "") :
        set?.toUpperCase() !== "CROWN ZENITH" || !/^#\s*GG\d+$/i.test(number ?? "") || !labelNamePrefix.test(name ?? "")) return false;

    const cardLines = text.slice(first + 7);
    const body = cardLines.join(" ");
    const fractions = body.match(/\b[A-Z]{0,4}\d{1,4}\s*\/\s*[A-Z]{0,4}\d{1,4}\b/gi) ?? [];
    const claims = text.join(" ");
    const englishFace = sv151
        ? cardLines.some(line => /^MEW EN$/i.test(line)) && /\b(?:weakness|evolves from|discard an energy)\b/i.test(body)
        : cardLines.some(line => /^Evolves from /i.test(line) &&
            sameCatalogName(line.replace(/^Evolves from /i, ""), reference.name.replace(/ VSTAR$/i, " V"))) &&
            /when your pok[eé]mon vstar is knocked out,? your opponent takes 2 prize cards\b/i.test(body);
    return englishFace && fractions.length === 1 && (sv151 ? /\/\s*165$/.test(fractions[0]) : /\/\s*GG70$/i.test(fractions[0])) &&
        sameCardNumber(fractions[0], reference.cardNumber) && cardLanguageStatus(claims) !== "OTHER" && ordinaryHoloClaims(claims, reference) &&
        !text.some(line => /^(?:OC|MK|MC|ST|PD|OF)$/i.test(line));
}
