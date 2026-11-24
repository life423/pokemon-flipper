import { AUTHENTICITY_FEATURES, AUTHENTICITY_JUDGMENTS } from "../../shared/authenticity.ts";
import type { Authenticity } from "../../shared/types.ts";

// A documented but unlocated concern can keep a listing on hold. It cannot
// establish either a counterfeit or an authentic card from prose alone.
export function hasUnlocatedConcern(input?: Authenticity | null): boolean {
    return Boolean(input?.concern === "POSSIBLE" && input.observations?.length === 0 &&
        input.reasons?.some(reason => typeof reason === "string" && reason.trim()) && input.limitations?.some(note => typeof note === "string" && note.trim()));
}

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
    const unlocated = hasUnlocatedConcern(input);
    if (!suspicious.length && (input.concern === "LIKELY_FAKE" || (input.concern === "POSSIBLE" && !observations.length && !unlocated))) return null;
    return { ...input,
        concern: suspicious.length && input.concern === "LIKELY_FAKE" ? "LIKELY_FAKE" : suspicious.length || unlocated ? "POSSIBLE" : "NONE_SEEN",
        reasons: unlocated ? [...new Set(["The photo assessment left authenticity uncertain without identifying a specific feature to check.", ...input.reasons])]
            : [...new Set(suspicious.map(item => item.observation + " Expected: " + item.expected))],
        observations,
        limitations: [...new Set([...input.limitations, ...observations.filter(item => item.judgment === "PHOTO_LIMITATION").map(item => item.observation),
            ...(!suspicious.length && !unlocated ? input.reasons : [])].map(note => note.trim()).filter(Boolean))],
    };
}
