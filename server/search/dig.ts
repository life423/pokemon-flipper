import { runStructured, MODEL } from "../ai/openai.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import type { FoundHow, SearchIntent } from "../../shared/types.ts";

// The extra eBay searches Dig deeper runs, aimed at single cards the plain
// search misses: misspelled names, number-only titles, and the wrong
// category. One page each.

const PLAN_VERSION = 1;
const MONTH_HOURS = 24 * 30;

export interface DigQuery {
    query: string;
    how: FoundHow;
    anyCategory?: boolean;
}

interface Variants {
    misspellings: string[];
    numbers: string[];
}

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["misspellings", "numbers"],
    properties: {
        misspellings: { type: "array", items: { type: "string" } },
        numbers: { type: "array", items: { type: "string" } },
    },
};

async function variants(intent: SearchIntent): Promise<Variants> {
    const card = `${intent.cardName}${intent.sets.length ? ` (${intent.sets.join(" or ")})` : ""}`;
    const key = `dig-variants:v${PLAN_VERSION}:${MODEL}:${card.toLowerCase()}`;
    const saved = await readCache<Variants>(key, MONTH_HOURS);

    if (saved) return saved;

    try {
        const { result } = await runStructured<Variants>({
            step: "Dig plan",
            prompt: `For the English Pokemon card ${card}, list:
- misspellings: up to 3 ways eBay sellers commonly misspell its name, lowercase, like "charzard" for Charizard. Only real-looking misspellings, never the correct spelling.
- numbers: its collector number in each of those sets, as printed, like "4/102". Empty if you're not sure.`,
            photos: [],
            schemaName: "dig_variants",
            schema: SCHEMA,
        });
        const cleaned = {
            misspellings: result.misspellings.map((word) => word.trim().toLowerCase()).filter(Boolean).slice(0, 3),
            numbers: result.numbers.map((number) => number.trim()).filter((number) => /^\d{1,3}\/\d{1,3}$/.test(number)).slice(0, 2),
        };

        await writeCache(key, cleaned);

        return cleaned;
    } catch (error) {
        console.error(`Dig plan failed: ${(error as Error).message}`);
        return { misspellings: [], numbers: [] };
    }
}

export async function digQueries(search: string, intent: SearchIntent): Promise<DigQuery[]> {
    const { misspellings, numbers } = await variants(intent);
    const set = intent.sets[0] ?? "";

    return [
        ...misspellings.map((word) => ({ query: `${word} ${set}`.trim(), how: "MISSPELLED" as const })),
        ...numbers.map((number) => ({ query: `${number} holo`, how: "NUMBER_ONLY" as const })),
        { query: search, how: "WRONG_CATEGORY", anyCategory: true },
    ];
}
