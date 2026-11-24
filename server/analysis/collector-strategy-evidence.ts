import type { SearchCompetition } from "../../shared/search-diagnostic.ts";
import { soldMarketPrice, usableSoldReference } from "../../shared/sold-evidence.ts";
import type { ScreeningSoldReference } from "../../shared/types.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createKeyedLock } from "../lib/keyed-lock.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { competitionRecord, isSearchDiagnosticId } from "./search-diagnostic-store.ts";

export interface CollectorStrategyEvidence {
    query: string;
    asOf: string;
    listing: SearchCompetition & { checkedAt: string; pricing: NonNullable<SearchCompetition["pricing"]> };
    reference: ScreeningSoldReference;
    label?: { grader: string; grade: string; cert?: string; source: string };
}

const locked = createKeyedLock();
const keyFor = (searchId: string) => `private-collector-strategy-input:v1:${searchId}`;

function checked(evidence: CollectorStrategyEvidence): CollectorStrategyEvidence {
    const { listing, reference, label } = evidence;
    competitionRecord(listing);
    if (!evidence.query?.trim() || !listing.checkedAt || evidence.asOf !== listing.checkedAt || !listing.pricing ||
        !reference?.grader || !reference.grade || !usableSoldReference(reference, true) ||
        listing.pricing.sales !== reference.summary.count || listing.pricing.resale !== soldMarketPrice(reference.summary) ||
        !Array.isArray(reference.summary.sales) || reference.summary.sales.some(sale =>
            !Number.isFinite(sale.price) || sale.price <= 0 || !Number.isFinite(Date.parse(sale.soldAt))) ||
        (label && (listing.identity === "LISTING" || !listing.image || label.grader !== reference.grader ||
            label.grade !== reference.grade || !label.source?.trim()))) {
        throw new StorageUnavailableError("Saved collector evidence is inconsistent.");
    }
    return evidence;
}

// The private, search-scoped record keeps the original destination quote and
// matched transactions together. Loading it never refreshes either provider.
export async function loadCollectorStrategyEvidence(searchId: string): Promise<CollectorStrategyEvidence | null> {
    if (!isSearchDiagnosticId(searchId)) return null;
    const saved = await readCache<CollectorStrategyEvidence>(keyFor(searchId), Infinity);
    return saved === null ? null : checked(saved);
}

export async function saveCollectorStrategyEvidence(searchId: string, evidence: CollectorStrategyEvidence): Promise<void> {
    if (!isSearchDiagnosticId(searchId)) throw new Error("A valid search ID is required.");
    checked(evidence);
    await locked(searchId, async () => {
        if (!await loadCollectorStrategyEvidence(searchId)) await writeCache(keyFor(searchId), evidence);
    });
}
