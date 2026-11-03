import { createHash } from "node:crypto";
import type { ListingDetails } from "../ebay/listings.ts";
import { readTitleByRules } from "../ai/title-reader.ts";
import { graderCode, normalizeGrade } from "../identity/slab-check.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { BOUNDED_REVIEW_REVISION, BOUNDED_CONDITION_REVISION, BOUNDED_SLAB_REVIEW_REVISION } from "../../shared/pricing-freshness.ts";
import { CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
import { BOUNDED_PHOTO_LIMIT } from "../../shared/research-policy.ts";
export { BOUNDED_PHOTO_LIMIT } from "../../shared/research-policy.ts";
import { EVALUATION_CLAIM_FIELDS } from "./private-evaluation.ts";

export const BOUNDED_VISION_MODEL = process.env.OPENAI_BOUNDED_VISION_MODEL ?? "gpt-5.6-luna";
export const BOUNDED_ASSESSMENT_VERSION = `${BOUNDED_VISION_MODEL}/bounded-prompts-${BOUNDED_REVIEW_REVISION}`;
export const BOUNDED_CONDITION_VERSION = `${BOUNDED_VISION_MODEL}/bounded-condition-${CONDITION_RULES_VERSION}/prompts-${BOUNDED_CONDITION_REVISION}`;
export const BOUNDED_SLAB_ASSESSMENT_VERSION = `${BOUNDED_VISION_MODEL}/bounded-slab-label-prompts-${BOUNDED_SLAB_REVIEW_REVISION}`;
export type BoundedAssessmentMode = "RAW" | "SLAB_LABEL";
export interface BoundedPhoto { number: number; url: string }
export interface BoundedAssessmentPlan { mode: BoundedAssessmentMode; version: string; photos: BoundedPhoto[]; key: string }

function uniquePhotos(urls: readonly string[]): BoundedPhoto[] {
    const seen = new Set<string>();
    return urls.flatMap((url, index) => {
        const key = normalizedPhoto(url);
        if (!url || seen.has(key)) return [];
        seen.add(key); return [{ number: index + 1, url }];
    });
}

// Keep the original combined selector/key stable so existing paid evidence can
// be reused and mapped with the photos it actually inspected.
export function selectBoundedPhotos(urls: readonly string[]): BoundedPhoto[] {
    const unique = uniquePhotos(urls);
    if (unique.length <= BOUNDED_PHOTO_LIMIT) return unique;
    const indices = [0, 1, ...[1, 2, 3, 4].map(step => 1 + Math.round(step * (unique.length - 2) / 4))];
    return [...new Set(indices)].sort((a, b) => a - b).map(index => unique[index]);
}
export function boundedClaims(listing: ListingDetails) {
    return Object.fromEntries(EVALUATION_CLAIM_FIELDS.filter(field => listing.aspects[field]).map(field => [field, listing.aspects[field]]));
}
function keyFor(listing: ListingDetails, version: string, photos: BoundedPhoto[]): string {
    const input = [version, listing.title.trim(), boundedClaims(listing), listing.images.map(normalizedPhoto), photos.map(photo => [photo.number, normalizedPhoto(photo.url)])];
    return `bounded-assessment:${version}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}
export function boundedAssessmentKey(listing: ListingDetails): string {
    return keyFor(listing, BOUNDED_ASSESSMENT_VERSION, selectBoundedPhotos(listing.images));
}

// Seller metadata selects the amount of work requested, never the physical
// holder, grader or certified grade used for valuation. Uncertain raw grading
// claims keep the full raw route. The model can disprove a slab claim.
function requestsSlabLabel(listing: ListingDetails): boolean {
    if (/^ungraded\b|\braw\b/i.test(listing.condition ?? "")) return false;
    if (/^(?:professionally\s+)?graded\b/i.test(listing.condition ?? "")) return true;
    if (graderCode(listing.aspects["Professional Grader"]) && normalizeGrade(listing.aspects.Grade)) return true;
    if (/\?|\b(?:potential|candidate|candidates|likely|possible|estimated|estimate|ready|worthy)\b/i.test(listing.title)) return false;
    const reading = readTitleByRules(listing.title);
    return Boolean(reading.grader && reading.grade);
}
function planFor(listing: ListingDetails, mode: BoundedAssessmentMode): BoundedAssessmentPlan {
    const version = mode === "RAW" ? BOUNDED_ASSESSMENT_VERSION : BOUNDED_SLAB_ASSESSMENT_VERSION;
    const photos = mode === "RAW" ? selectBoundedPhotos(listing.images) : uniquePhotos(listing.images).slice(0, 2);
    return { mode, version, photos, key: keyFor(listing, version, photos) };
}
export function boundedAssessmentPlan(listing: ListingDetails): BoundedAssessmentPlan {
    return planFor(listing, requestsSlabLabel(listing) ? "SLAB_LABEL" : "RAW");
}
export function compatibleBoundedPlans(listing: ListingDetails): BoundedAssessmentPlan[] {
    const requested = boundedAssessmentPlan(listing);
    // The physical holder is model evidence. A changed advisory seller
    // category must not force another assessment of an already-read slab.
    return [requested, planFor(listing, requested.mode === "RAW" ? "SLAB_LABEL" : "RAW")];
}
