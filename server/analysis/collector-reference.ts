import { sameCardNumber } from "../../shared/card-number.ts";
import { normalizeSetName } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { fetchJson } from "../lib/http.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import type { HuntMarket } from "./same-set-markets.ts";

export interface CollectorReference { cardName: string; setName: string; cardNumber: string; imageUrl: string }
type Target = Pick<HuntMarket, "name" | "set" | "cardNumber">;
interface CatalogCard {
    id: string; localId: string; name: string; image: string;
    set: { id: string; name: string; cardCount: { official: number } };
}

const asset = /^https:\/\/assets\.tcgdex\.net\/en\/[a-z0-9][a-z0-9.-]*\/([a-z0-9][a-z0-9.-]*)\/([a-z0-9][a-z0-9-]*)$/i;
const numbered = /^#?([a-z]{0,6}\d{1,4}[a-z]?)(?:\s*\/\s*([a-z]{0,6}\d{1,4}[a-z]?))?$/i;
const share = createSharedWork();

function matchedReference(card: CatalogCard | null, target: Target): CollectorReference | null {
    const official = card?.set?.cardCount?.official;
    if (!card || !Number.isSafeInteger(official) || Number(official) <= 0 ||
        typeof card.name !== "string" || typeof card.set.name !== "string" || !sameCatalogName(card.name, target.name) ||
        normalizeSetName(card.set.name) !== normalizeSetName(target.set) || typeof card.localId !== "string" ||
        card.id !== card.set.id + "-" + card.localId || typeof card.image !== "string") return null;
    const coordinates = asset.exec(card.image);
    const cardNumber = card.localId + "/" + official;
    if (!coordinates || coordinates[1] !== card.set.id || coordinates[2] !== card.localId || !sameCardNumber(cardNumber, target.cardNumber)) return null;
    return { cardName: card.name, setName: card.set.name, cardNumber, imageUrl: card.image + "/high.jpg" };
}

// Resolve the stored market's artwork from an independent English catalog.
// A seller's title, photo URL or suggested catalog match never supplies the reference.
export async function resolveCollectorReference(target: Target, signal?: AbortSignal): Promise<CollectorReference | null> {
    signal?.throwIfAborted();
    const set = normalizeSetName(target.set);
    const number = numbered.exec(target.cardNumber.trim());
    if (!set || !target.name.trim() || !number) return null;
    // The catalog accepts unpadded lookup numbers for both old and modern sets.
    // Some older sets return 404 if a provider supplied leading zeroes.
    const localId = number[1]!.toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, "$1");
    const key = "tcgdex:en:reference:v1:" + JSON.stringify([set, localId]);
    const saved = await readCache<CatalogCard>(key, 24 * 30);
    signal?.throwIfAborted();
    if (saved) return matchedReference(saved, target);
    requireLiveProvider("TCGDEX");
    const card = await share(key, async activeSignal => {
        const url = "https://api.tcgdex.net/v2/en/sets/" + encodeURIComponent(set) + "/" + encodeURIComponent(localId);
        let data: CatalogCard;
        try {
            const { response, body } = await fetchJson(url, { signal: activeSignal, redirect: "error" }, { service: "TCGdex", timeoutMs: 6000 });
            if (!response.ok) return null;
            data = body;
        } catch {
            activeSignal.throwIfAborted();
            return null;
        }
        // Cache only catalog entries with internally consistent identity and artwork.
        // No response, transport failure or mismatched card becomes saved evidence.
        if (!data || typeof data.name !== "string" || !matchedReference(data, { name: data.name, set, cardNumber: localId })) return null;
        const entry: CatalogCard = { id: data.id, localId: data.localId, name: data.name, image: data.image,
            set: { id: data.set.id, name: data.set.name, cardCount: { official: data.set.cardCount.official } } };
        activeSignal.throwIfAborted();
        await writeCache(key, entry);
        return entry;
    }, signal);
    return matchedReference(card, target);
}
