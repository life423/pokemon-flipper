import { cleanPhotoCard } from "./photo-card-schema.ts";
import { RAW_CONDITIONS, type RawCondition } from "../../shared/conditions.ts";
import { normalizeWords, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import type { Identity, PhotoCardReading } from "../../shared/types.ts";

// Read compatibility for saved sold-copy photo evidence. The current bounded
// workflow reuses accepted observations; it never launches historical reviews.
export interface SoldConditionReading {
    card: PhotoCardReading;
    printing: string;
    condition: RawCondition | "UNKNOWN";
    confidence: string;
    oneRawCard: boolean;
    frontVisible: boolean;
    backVisible: boolean;
    closeUps: boolean;
    structuralDamage: boolean;
    evidence: string[];
    limitations: string[];
}
export interface SoldConditionEvidence { condition: RawCondition; evidence: string[]; photoCount: number }
export function acceptedSoldCondition(result: SoldConditionReading, identity: Identity, photoCount: number): SoldConditionEvidence | null {
    const card = cleanPhotoCard(result.card);
    if (!result.oneRawCard || !result.frontVisible || card.confidence !== "HIGH" || !card.evidence.length || normalizeWords(card.language) !== "english" ||
        normalizeWords(card.name) !== normalizeWords(identity.name) || !sameSetFamily(card.set, identity.set) || !sameCardNumber(card.cardNumber, identity.cardNumber) ||
        card.finish !== identity.finish || result.printing !== identity.printing || !result.evidence.length) return null;
    const condition = result.structuralDamage ? "DAMAGED" : result.condition;
    if (condition === "UNKNOWN" || !RAW_CONDITIONS.includes(condition)) return null;
    if (condition !== "DAMAGED" && (!result.backVisible || result.confidence !== "HIGH")) return null;
    if (condition === "MINT" && (!result.closeUps || result.confidence !== "HIGH")) return null;
    if (condition === "DAMAGED" && !["HIGH", "MEDIUM"].includes(result.confidence)) return null;
    return { condition, evidence: result.evidence, photoCount };
}

export function corroboratedSoldCondition(first: SoldConditionReading, second: SoldConditionReading, identity: Identity, photoCount: number): SoldConditionEvidence | null {
    if (!["HIGH", "MEDIUM"].includes(first.confidence) || !["HIGH", "MEDIUM"].includes(second.confidence) ||
        first.condition === "MINT" || first.condition === "UNKNOWN" || first.condition !== second.condition || first.structuralDamage !== second.structuralDamage) return null;
    // Agreement may resolve a medium-confidence wear category, but never supply
    // missing sides, identity/printing evidence, or a Mint premium.
    const a = acceptedSoldCondition({ ...first, confidence: "HIGH" }, identity, photoCount);
    const b = acceptedSoldCondition({ ...second, confidence: "HIGH" }, identity, photoCount);
    return a && b && a.condition === b.condition ? { ...a, evidence: [...new Set([...a.evidence, ...b.evidence, "Two independent photo readings agree on this condition."])] } : null;
}
