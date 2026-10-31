import { RAW_CONDITIONS, type RawCondition } from "../../shared/conditions.ts";
import type { CompSummary, Identity, RawPrice, RawPricing } from "../../shared/types.ts";
import { rawPricesFor, variantFor } from "./raw-prices.ts";
import { compProblem, summarizeComps } from "./graded-comps.ts";
import type { CheckComps, Comp, FetchRawComps, PricedCard } from "./types.ts";
import type { SoldConditionEvidence } from "../ai/sold-condition.ts";

// Seller text is used only for screening/bootstrap. Final valuations classify
// sold-copy photos independently; an unknown condition is never assumed NM.
export function compCondition(title: string): RawCondition | null {
    if (/\b(?:mint|nm|lp|mp|hp|dmg|damaged)\s*\?/i.test(title)) return null;
    const text = title.replace(/\b\d+\s*hp\b/gi, "");
    const patterns: [RawCondition, RegExp][] = [
        ["NEAR_MINT", /\bnear[ -]?mint\b|\bnm\b/i],
        ["MINT", /\bmint\b/i],
        ["LIGHTLY_PLAYED", /\blightly[ -]?played\b|\blp\b/i],
        ["MODERATELY_PLAYED", /\bmoderately[ -]?played\b|\bmp\b/i],
        ["HEAVILY_PLAYED", /\bheavily[ -]?played\b|\bhp\b/i],
        ["DAMAGED", /\bdamaged\b|\bdmg\b/i],
    ];
    const matches = patterns.filter(([condition, pattern]) => pattern.test(condition === "MINT" ? text.replace(/\bnear[ -]?mint\b/gi, "") : text));
    return matches.length === 1 ? matches[0][0] : null;
}

export async function rawPricesWithSales(card: PricedCard | null, identity: Identity, {
    fetchRawComps, checkComps, now = Date.now(), assessCondition,
}: { fetchRawComps: FetchRawComps; checkComps?: CheckComps; now?: number; assessCondition?: (sale: Comp, identity: Identity) => Promise<SoldConditionEvidence | null> }): Promise<RawPricing> {
    const fallback = rawPricesFor(card, identity);
    const { variant } = variantFor(card, identity);
    if (!variant || !card || card.source !== "pkmnprices" || identity.status !== "IDENTIFIED") return fallback;
    try {
        const fetched = await fetchRawComps(variant.recordId, variant.name);
        let sales = [...new Map(fetched.map(sale => [sale.id ?? sale.listing_url ?? JSON.stringify(sale), sale])).values()];
        const sampledSoldCopies = sales.length;
        if (assessCondition) {
            const eligible = sales.filter(sale => sale.currency === "USD" && sale.sale_type && !sale.grader && !sale.grade &&
                !/\b(psa|cgc|bgs|sgc|tag|lot|bundle)\b/i.test(sale.title) && compProblem({ ...sale, grader: "RAW", grade: "ANY" },
                    { printing: identity.printing, setName: variant.setName, finish: variant.finish, grader: "RAW", grade: "ANY", now, windowDays: 90 }) === null).slice(0, 12);
            sales = (await Promise.all(eligible.map(async sale => {
                const assessed = await assessCondition(sale, identity).catch(() => null);
                return assessed ? { ...sale, photoCondition: assessed.condition, conditionEvidence: assessed.evidence, sellerCondition: compCondition(sale.title) } : null;
            }))).filter((sale): sale is Comp & { photoCondition: import("../../shared/conditions.ts").RawCondition; conditionEvidence: string[]; sellerCondition: import("../../shared/conditions.ts").RawCondition | null } => sale !== null);
        }
        const summaries: CompSummary[] = [];
        for (const condition of RAW_CONDITIONS) {
            const criteria = { printing: identity.printing, setName: variant.setName, finish: variant.finish, grader: "RAW", grade: condition, now, windowDays: 90 as const };
            const normalized = sales.map(sale => ({ ...sale, grader: "RAW", grade: condition }));
            const passing: Comp[] = [];
            const rejected: Record<string, number> = {};
            for (let i = 0; i < sales.length; i += 1) {
                const original = sales[i];
                const age = (now - Date.parse(original.sold_at)) / 86400000;
                const reason = original.currency !== "USD" ? "not a USD sale"
                    : original.grader || original.grade || /\b(psa|cgc|bgs|sgc|tag)\b/i.test(original.title) ? "graded or grading claim"
                    : !original.sale_type ? "sale amount not confirmed"
                    : /\blot\b|\bbundle\b|\bset of\b|\b\d+\s*(cards|pcs)\b/i.test(original.title) ? "not a single card"
                    : (assessCondition ? original.photoCondition : compCondition(original.title)) !== condition ? "condition unstated or different"
                    : age > 90 ? "older than 90 days"
                    : compProblem(normalized[i], criteria);
                if (reason) rejected[reason] = (rejected[reason] ?? 0) + 1;
                else passing.push(normalized[i]);
            }
            const verdicts = checkComps && passing.length ? await checkComps(passing, {
                cardName: identity.name ?? card.name, setName: variant.setName ?? identity.set ?? "",
                cardNumber: identity.cardNumber ?? card.cardNumber, printingLabel: fallback.printingLabel ?? identity.printingLabel ?? "",
                grader: "RAW", grade: condition,
                finish: variant.finish, ...(assessCondition ? { conditionEvidence: "AI_PHOTOS" as const } : {}),
            }) : undefined;
            const checked = checkComps ? passing.filter(sale => {
                if (verdicts?.has(sale)) return true;
                rejected["sale identity not checked"] = (rejected["sale identity not checked"] ?? 0) + 1;
                return false;
            }) : passing;
            const summary = summarizeComps(checked, criteria, verdicts);
            summary.dropped = { ...rejected, ...summary.dropped };
            summaries.push(summary);
        }
        const prices = RAW_CONDITIONS.flatMap<RawPrice>(condition => {
            const summary = summaries.find(s => s.grade === condition)!;
            const market = fallback.prices?.find(p => p.condition === condition);
            // A lone premium copy or a pair of sales cannot overwrite the feed.
            if (summary.count >= 3 && summary.median !== null) return [{ condition, price: summary.median, updatedAt: summary.newestSale, basis: "EBAY_SOLD" as const, comps: summary }];
            return market ? [{ ...market, basis: "TCGPLAYER" as const }] : [];
        });
        return { ...fallback, status: prices.length ? "PRICED" : "PRICE_UNAVAILABLE", prices, ebayComps: summaries,
            conditionEvidence: assessCondition ? "AI_PHOTOS" : "SELLER_TEXT", reviewedSoldCopies: assessCondition ? sales.length : undefined, sampledSoldCopies,
            evidenceNote: assessCondition ? `${sales.length} sold copies have accepted AI photo-condition assessments from ${sampledSoldCopies} returned records. Up to 12 copies receive photo review per card lookup; results are reused for unchanged photos. Three matched sales are required for an eBay median; other conditions retain a marked market fallback.`
                : "Screening uses seller-stated raw conditions. Final evaluations assess sold-copy photos where available. Up to 40 returned records over 90 days are sampled." };
    } catch {
        return { ...fallback, prices: fallback.prices?.map(p => ({ ...p, basis: "TCGPLAYER" })), evidenceNote: "eBay raw sales are temporarily unavailable; using the condition-specific TCGplayer market fallback." };
    }
}
