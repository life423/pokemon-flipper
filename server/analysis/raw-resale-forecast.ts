import { isRawCondition, type RawCondition } from "../../shared/conditions.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { rawPriceForPath, photoMatchedRawPrice } from "../../shared/money/price-evidence.ts";
import { relistEstimate, type ComparableAsk, type SaleStatistic } from "../../shared/money/relist-estimate.ts";
import type { Evaluation, Identity, PricedPath } from "../../shared/types.ts";
import { huntPhotoIdentityIssue } from "./deal-hunt-market-checks.ts";

export interface RawResaleForecast {
    version: 1;
    listingId: string;
    issuedAt: string;
    identity: Identity;
    variant: string;
    condition: RawCondition;
    baseline: number;
    expected: number | null;
    competitor: ComparableAsk | null;
    trainingIds: string[];
    source: "finalist" | "archived sold estimate";
}

export function captureRawForecast(value: Evaluation, path: PricedPath, at: number, competitor: ComparableAsk | null,
    statistic: SaleStatistic, supported: boolean): RawResaleForecast | undefined {
    const id = value.identity, condition = path.priceCondition, raw = value.rawPricing;
    const summary = rawPriceForPath(raw, path)?.comps;
    if (path.path !== "RAW" || !id?.recordId || id.notThisCard || !readyForPricing(id) || huntPhotoIdentityIssue(value) ||
        !isRawCondition(condition) || value.condition?.rawCondition !== condition || raw?.printing !== id.printing ||
        raw?.finish !== id.finish || !raw.variant || !summary || !path.salePrice ||
        photoMatchedRawPrice(summary, condition) !== path.salePrice || summary.sales.some(s => Date.parse(s.soldAt) > at)) return;
    const projection = relistEstimate(value, path, competitor, at, statistic);
    return { version: 1, source: "finalist", listingId: value.listing.id, issuedAt: new Date(at).toISOString(),
        identity: id, variant: raw.variant, condition, baseline: path.salePrice, expected: supported ? projection?.price ?? null : null,
        competitor, trainingIds: summary.sales.map(s => parseListingLink(s.url)!.itemId) };
}
