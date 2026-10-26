import type { PhotoCardReading } from "../../shared/types.ts";

const NULLABLE = { type: ["string", "null"] };
export const PHOTO_CARD_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["name", "set", "cardNumber", "finish", "language", "confidence", "evidence"],
    properties: {
        name: NULLABLE, set: NULLABLE, cardNumber: NULLABLE, language: NULLABLE,
        finish: { type: "string", enum: ["HOLO", "NON_HOLO", "REVERSE_HOLO", "UNKNOWN"] },
        confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        evidence: { type: "array", items: { type: "string" } },
    },
};

// Explanatory photo notes belong in evidence, not a database lookup key.
export function cleanPhotoCard(card: PhotoCardReading): PhotoCardReading {
    const set = card.set?.replace(/\s*\([^)]*(?:symbol|artwork|copyright|original|printing|english)[^)]*\)/gi, "")
        .split(/\s+[—–]\s+/)[0].trim() ?? null;
    return { ...card, set };
}
