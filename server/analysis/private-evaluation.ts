import { createHash } from "node:crypto";
import { readCache, writeCache } from "../lib/cache.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { printingClaimFromAspects } from "../identity/card-identity.ts";
import type { Evaluation } from "../../shared/types.ts";

// This namespace is deliberately absent from the SQL public-cache allowlist:
// financial results belong to the owner, while photo facts remain shareable.
export const PRIVATE_EVALUATION_PREFIX = "private-evaluation:v1:";
export const EVALUATION_CLAIM_FIELDS = ["Card Name", "Character", "Set", "Card Number", "Language", "Finish", "Professional Grader", "Grade", "Certification Number", "Year Manufactured"];
export interface PrivateEvaluationSnapshot { version: 1; evidenceKey: string; contextKey: string; evaluation: Evaluation }
export function evaluationContextKey(listing: { title: string; images: readonly string[]; aspects: Record<string, string> }): string {
    const input = [listing.title.trim(), listing.images.map(normalizedPhoto),
        EVALUATION_CLAIM_FIELDS.map(field => [field, listing.aspects[field] ?? null])];
    // Edition/Features/Printing can change identity without changing the paid
    // photo inputs. Keep their semantic claim in financial context only.
    const printing = printingClaimFromAspects(listing.aspects);
    if (printing !== "NOT_STATED") input.push(printing);
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
const keyFor = (id: string) => PRIVATE_EVALUATION_PREFIX + createHash("sha256").update(id).digest("hex");
function validate(value: unknown, itemId: string): PrivateEvaluationSnapshot {
    const entry = value as PrivateEvaluationSnapshot | null;
    const listing = entry?.evaluation?.listing;
    const amount = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!entry || entry.version !== 1 || typeof entry.evidenceKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.contextKey) ||
        !listing || listing.id !== itemId || typeof listing.title !== "string" || !Array.isArray(listing.photos) || !listing.photos.every(photo => typeof photo === "string") ||
        !amount(listing.price) || !amount(listing.shipping) || typeof entry.evaluation.assessmentVersion !== "string" ||
        !Number.isSafeInteger(listing.photosInListing) || !Number.isSafeInteger(listing.photosAnalyzed) || listing.photosAnalyzed < 0 || listing.photosAnalyzed > listing.photosInListing) {
        throw new StorageUnavailableError("The saved private evaluation is invalid. It was kept; no replacement provider work was authorized.");
    }
    return entry;
}
export function createPrivateEvaluationStore({ cached = readCache, save = writeCache } = {}) {
    return {
        async load(itemId: string): Promise<PrivateEvaluationSnapshot | null> {
            const value = await cached<PrivateEvaluationSnapshot>(keyFor(itemId), 24 * 30);
            return value === null ? null : structuredClone(validate(value, itemId));
        },
        async save(evaluation: Evaluation, context: Pick<PrivateEvaluationSnapshot, "evidenceKey" | "contextKey">): Promise<void> {
            const entry: PrivateEvaluationSnapshot = { version: 1, ...context, evaluation: structuredClone(evaluation) };
            validate(entry, evaluation.listing.id);
            await save(keyFor(evaluation.listing.id), entry);
        },
    };
}
const privateEvaluationStore = createPrivateEvaluationStore();
export const loadPrivateEvaluation = privateEvaluationStore.load;
