import { isDeepStrictEqual } from "node:util";

export const PRICE_SEARCH_MODEL = "gpt-5.6-luna";
export const PRICE_SEARCH_OUTPUT_TOKENS = 1400;
export const PRICE_SEARCH_DOMAINS = ["ebay.com", "psacard.com", "pricecharting.com", "fanaticscollect.com"];
// GA web_search costs $10 per 1,000 calls. The tool's low context setting is a
// preference. Reserve the full 128k web context in addition to counted input.
export const WEB_SEARCH_FEE_NANO_USD = 10_000_000;
export const WEB_SEARCH_CONTEXT_BOUND = 128 * 1024;

export function priceSearchTools() {
    return {
        tools: [{ type: "web_search" as const, search_context_size: "low" as const, filters: { allowed_domains: [...PRICE_SEARCH_DOMAINS] } }],
        tool_choice: "required" as const,
        max_tool_calls: 1,
        parallel_tool_calls: false,
        include: ["web_search_call.action.sources" as const],
    };
}

export function isBoundedPriceSearch(body: any): boolean {
    const options = priceSearchTools();
    return body?.model === PRICE_SEARCH_MODEL && body.max_output_tokens === PRICE_SEARCH_OUTPUT_TOKENS &&
        body.metadata?.app_step === "Web price research" && body.text?.format?.name === "web_price_research" &&
        Object.entries(options).every(([key, value]) => isDeepStrictEqual(body[key], value));
}
