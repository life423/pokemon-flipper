import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import type { findDeals } from "../../server/deals/find-deals.ts";
import type { ListingSummary } from "../../shared/types.ts";

type Steps = NonNullable<Parameters<typeof findDeals>[2]>;
export function offlineSearchSteps(rows: ListingSummary[], overrides: Partial<Steps> = {}): Steps {
    return {
        readIntent: async query => readSearchLocally(query),
        readTitle: async title => readTitleByRules(title),
        search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
        soldScreening: () => async () => ({ status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sold references in this offline fixture." }),
        ...overrides,
    };
}
