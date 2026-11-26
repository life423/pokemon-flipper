import { AsyncLocalStorage } from "node:async_hooks";

type Provider = "EBAY" | "PKMNPRICES" | "POKEMON_PRICE_TRACKER" | "OPENAI" | "TCGDEX" | "SILPHCO" | "POKEPRICE" | "PRICECHARTING";
const savedOnly = new AsyncLocalStorage<(provider: Provider) => void>();

export function withSavedProviderEvidence<T>(onMissing: (provider: Provider) => void, work: () => T): T {
    return savedOnly.run(onMissing, work);
}

// Benchmarks may reuse cached evidence. Block a cache miss before reserving
// quota or creating a spending hold; the transport guard is a second barrier.
export function requireLiveProvider(provider: Provider): void {
    const onMissing = savedOnly.getStore();
    if (!onMissing) return;
    onMissing(provider);
    throw new Error(`Saved evidence is missing for ${provider}. No provider request was authorized.`);
}
