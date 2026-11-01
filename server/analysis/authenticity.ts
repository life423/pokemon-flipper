import { AUTHENTICITY_FEATURES, AUTHENTICITY_JUDGMENTS } from "../../shared/authenticity.ts";
import type { Authenticity } from "../../shared/types.ts";

// Legacy saved reports keep their caution until the condition stage is rerun.
// Only the new structured contract can distinguish no suspicious evidence from
// unavailable coverage; do not erase old concerns by matching reassuring prose.
export function normalizeAuthenticity(input: Authenticity, photoCount = 24): Authenticity | null {
    if (!input || typeof input !== "object") return null;
    if (input.observations === undefined) return structuredClone(input);
    if (!Array.isArray(input.observations) || !Array.isArray(input.limitations) ||
        !Array.isArray(input.reasons) || !input.reasons.every(reason => typeof reason === "string") ||
        !input.limitations.every(note => typeof note === "string") ||
        !["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"].includes(input.concern)) return null;
    if (input.observations.some(item => !item || !Number.isInteger(item.photoNumber) || item.photoNumber < 1 || item.photoNumber > photoCount ||
        !AUTHENTICITY_FEATURES.includes(item.feature) || !AUTHENTICITY_JUDGMENTS.includes(item.judgment) ||
        typeof item.observation !== "string" || !item.observation.trim() || typeof item.expected !== "string" || !item.expected.trim())) return null;
    const observations = input.observations.map(item => ({ ...item, observation: item.observation.trim(), expected: item.expected.trim() }));
    const suspicious = observations.filter(item => item.judgment === "SUSPICIOUS");
    // An unsupported alert is incomplete and must be retried,
    // never silently converted into a clean assessment.
    if (!suspicious.length && (input.concern === "LIKELY_FAKE" || (input.concern === "POSSIBLE" && !observations.length))) return null;
    return { ...input,
        concern: suspicious.length ? input.concern === "LIKELY_FAKE" ? "LIKELY_FAKE" : "POSSIBLE" : "NONE_SEEN",
        reasons: [...new Set(suspicious.map(item => item.observation + " Expected: " + item.expected))],
        observations,
        limitations: [...new Set([...input.limitations, ...observations.filter(item => item.judgment === "PHOTO_LIMITATION").map(item => item.observation),
            ...(!suspicious.length ? input.reasons : [])].map(note => note.trim()).filter(Boolean))],
    };
}
