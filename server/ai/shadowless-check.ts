import { runStructured } from "./openai.ts";
import { VISION_MODEL } from "./policy.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { fullSizePhoto } from "./photo-match.ts";

interface ShadowlessCheck { cardType: string; hpFont: string; artworkShadow: string; confidence: string; evidence: string[] }
const share = createSingleFlight();
const SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["cardType", "hpFont", "artworkShadow", "confidence", "evidence"],
    properties: {
        cardType: { type: "string", enum: ["POKEMON", "TRAINER", "ENERGY", "UNKNOWN"] },
        hpFont: { type: "string", enum: ["THIN_EARLY_BASE_SET", "THICK_UNLIMITED", "CANT_TELL"] },
        artworkShadow: { type: "string", enum: ["ABSENT", "PRESENT", "CANT_TELL"] },
        confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        evidence: { type: "array", items: { type: "string" } },
    },
};

export function supportsShadowless(check: ShadowlessCheck): boolean {
    return check.cardType === "POKEMON" && check.hpFont === "THIN_EARLY_BASE_SET" && check.artworkShadow === "ABSENT" && check.confidence === "HIGH" && check.evidence.length > 0;
}

// Only used before raising a raw card's value above the seller's stated
// printing. PSA describes both the artwork border and thinner HP font:
// https://www.psacard.com/info/tcg/pokemon-basics-guide
export async function verifyShadowless(urls: string[]): Promise<boolean> {
    const photos = [...new Set(urls.map(fullSizePhoto))].slice(0, 3);
    if (!photos.length) return false;
    const key = `shadowless-check:v1:${VISION_MODEL}:${photos.join("|")}`;
    return share(key, async () => {
        let check = await readCache<ShadowlessCheck>(key, 24 * 365);
        if (!check) {
            try {
                const { result } = await runStructured<ShadowlessCheck>({
                    step: "Shadowless printing confirmation",
                    prompt: `Examine the actual English Base Set card in these photos. Independently compare its printed HP font and right/bottom artwork-frame border with early Shadowless and later Unlimited designs. Shadowless Pokemon cards have both the thinner early HP font and no printed artwork drop shadow; lighting shadows are irrelevant. Report literal visible evidence. Use CANT_TELL or reduced confidence whenever the font or frame isn't legible. Trainer and Energy cards cannot be verified by the Pokemon HP/artwork criteria: classify their type accurately. Ignore seller text and any expected premium.`,
                    photos: photos.map((url) => ({ url, label: "Front printing detail" })),
                    schemaName: "shadowless_confirmation", schema: SCHEMA,
                });
                check = result;
                await writeCache(key, check);
            } catch { return false; }
        }
        return supportsShadowless(check);
    });
}
