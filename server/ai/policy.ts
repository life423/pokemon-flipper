// Preserve an explicit legacy model override. Vision can be configured
// separately; cheap text extraction does not need the assessment model.
export const TEXT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";
export const VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6-terra";
const VISION_SCHEMAS = new Set(["photo_check", "card_condition", "focused_photo_review", "shadowless_confirmation", "identity_resolution", "sold_card_condition"]);
export function aiPolicy(schema: string) {
    const assessment = VISION_SCHEMAS.has(schema);
    const model = assessment ? VISION_MODEL : TEXT_MODEL;
    const maxOutputTokens = schema === "photo_check" ? 16384 : schema === "title_readings" || schema === "card_condition" || schema === "focused_photo_review" ? 8192 : schema === "comp_check" ? 4096 : schema === "search_intent" || schema === "offer_note" ? 2048 : 4096;
    return { model, maxOutputTokens, effort: assessment ? "medium" as const : "low" as const,
        supportsReasoning: /^(?:gpt-[56](?:[.-]|$)|o\d)/.test(model) };
}
