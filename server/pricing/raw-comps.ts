import { RAW_CONDITIONS, type RawCondition } from "../../shared/conditions.ts";
import type { CompSummary, Identity, RawPrice, RawPricing } from "../../shared/types.ts";
import { variantFor } from "./raw-prices.ts";
import { printingLabel } from "../identity/card-identity.ts";
import { compProblem, matchesSoldTarget, summarizeComps, uniqueSoldComps } from "./sold-comps.ts";
import type { CheckComps, Comp, FetchRawComps, PricedCard } from "./types.ts";
import type { SoldConditionEvidence } from "../ai/sold-condition.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { MIN_MATCHED_SALES } from "../../shared/sold-evidence.ts";

// Seller text only bootstraps screening; final valuations inspect sold photos.
export { rawConditionClaim as compCondition } from "../../shared/raw-condition-claim.ts";
import { rawConditionClaim as compCondition } from "../../shared/raw-condition-claim.ts";

export async function rawPricesWithSales(card: PricedCard | null, identity: Identity, {
    fetchRawComps, checkComps, now = Date.now(), assessCondition, acquireCondition, requestedCondition, signal,
}: { fetchRawComps: FetchRawComps; checkComps?: CheckComps; now?: number; assessCondition?: (sale: Comp, identity: Identity, signal?: AbortSignal) => Promise<SoldConditionEvidence | null>;
    acquireCondition?: (sales: readonly Comp[], identity: Identity, signal?: AbortSignal) => Promise<{ sale: Comp; evidence: SoldConditionEvidence } | null>;
    requestedCondition?: RawCondition; signal?: AbortSignal }): Promise<RawPricing> {
    signal?.throwIfAborted();
    if (!readyForPricing(identity) || !identity.name?.trim()) {
        return { status: "PRICE_UNAVAILABLE", reason: "The card isn't fully identified, so its raw sales can't be matched." };
    }
    if (card?.source !== "pkmnprices") {
        return { status: "PRICE_UNAVAILABLE", reason: "No eBay sold market is available for this card." };
    }
    const { variant, reason } = variantFor(card, identity);
    if (!variant) return { status: "PRICE_UNAVAILABLE", reason };
    if (assessCondition && !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish)) {
        return { status: "PRICE_UNAVAILABLE", reason: "The card's finish must be established before matching sold-copy condition evidence." };
    }
    const market = { source: card.source, printing: variant.printing, printingLabel: printingLabel(variant.printing, identity.set),
        finish: variant.finish, variant: variant.name };
    try {
        const eligibleSale = (sale: Comp) => sale.currency === "USD" && sale.sale_type && !sale.grader && !sale.grade &&
            !/\b(psa|cgc|bgs|sgc|tag|lot|bundle)\b/i.test(sale.title) && compProblem({ ...sale, grader: "RAW", grade: "ANY" },
                { printing: identity.printing, setName: variant.setName, finish: variant.finish, grader: "RAW", grade: "ANY", now, windowDays: 90 }) === null;
        const fetched = await fetchRawComps(variant.recordId, variant.name, assessCondition ? { stopWhen: sales => sales.some(sale =>
            eligibleSale(sale) && matchesSoldTarget(sale, { name: identity.name!, setName: variant.setName, cardNumber: identity.cardNumber })) } : undefined);
        signal?.throwIfAborted();
        let sales = uniqueSoldComps(fetched);
        const sampledSoldCopies = sales.length;
        if (assessCondition) {
            const eligible = sales.filter(eligibleSale);
            const accepted = new Map<Comp, SoldConditionEvidence>();
            let cacheReadFailed = false;
            // This callback reads accepted evidence only. New photo work has
            // a separate, one-shot acquisition after every cache read finishes.
            await Promise.all(eligible.map(async sale => {
                signal?.throwIfAborted();
                const assessed = await assessCondition(sale, identity, signal).catch(() => { signal?.throwIfAborted(); cacheReadFailed = true; return null; });
                signal?.throwIfAborted();
                if (assessed) accepted.set(sale, assessed);
            }));
            const matched = [...accepted.values()].filter(evidence => evidence.condition === requestedCondition).length;
            const unassessed = eligible.filter(sale => !accepted.has(sale));
            if (acquireCondition && requestedCondition && RAW_CONDITIONS.includes(requestedCondition) &&
                !cacheReadFailed && matched < MIN_MATCHED_SALES && unassessed.length) {
                signal?.throwIfAborted();
                const acquired = await acquireCondition(Object.freeze(unassessed), identity, signal);
                signal?.throwIfAborted();
                // The callback validates physical identity/condition; it may
                // only supply evidence for an offered source copy, never inject
                // a different transaction or alter its price/printing fields.
                if (acquired && unassessed.includes(acquired.sale) && RAW_CONDITIONS.includes(acquired.evidence.condition) &&
                    acquired.evidence.evidence.length && Number.isSafeInteger(acquired.evidence.photoCount) && acquired.evidence.photoCount > 0) {
                    accepted.set(acquired.sale, acquired.evidence);
                }
            }
            sales = eligible.flatMap(sale => {
                const assessed = accepted.get(sale);
                return assessed ? [{ ...sale, photoCondition: assessed.condition, conditionEvidence: assessed.evidence, sellerCondition: compCondition(sale.title) }] : [];
            });
        }
        const summaries: CompSummary[] = [];
        for (const condition of RAW_CONDITIONS) {
            signal?.throwIfAborted();
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
                cardNumber: identity.cardNumber ?? card.cardNumber, printingLabel: market.printingLabel,
                grader: "RAW", grade: condition,
                finish: variant.finish, ...(assessCondition ? { conditionEvidence: "AI_PHOTOS" as const } : {}),
            }, signal) : undefined;
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
            // The shared sparse-sale policy applies to physical-condition
            // evidence. Keep the legacy title-only floor until its final-price
            // compatibility path is retired; seller text cannot gain admission.
            const minimum = assessCondition ? MIN_MATCHED_SALES : 3;
            if (summary.count >= minimum && summary.median !== null) return [{ condition, price: summary.median, updatedAt: summary.newestSale, basis: "EBAY_SOLD" as const, comps: summary }];
            return [];
        });
        return { ...market, ...(prices.length ? { status: "PRICED", prices } : {
            status: "PRICE_UNAVAILABLE", reason: "The available eBay sales don't establish a raw resale price for this printing and condition.",
        }), ebayComps: summaries,
            conditionEvidence: assessCondition ? "AI_PHOTOS" : "SELLER_TEXT", reviewedSoldCopies: assessCondition ? sales.length : undefined, sampledSoldCopies,
            evidenceNote: assessCondition ? `${sales.length} sold copies have accepted photo-condition assessments from ${sampledSoldCopies} returned records. Accepted findings are reused for unchanged photos. Matched-sale minimum for an eBay median: ${MIN_MATCHED_SALES}; one or two sales retain LOW confidence.`
                : "Screening uses seller-stated raw conditions. Final evaluations assess sold-copy photos where available. Up to 40 returned records over 90 days are sampled." };
    } catch {
        signal?.throwIfAborted();
        return { ...market, status: "PRICE_UNAVAILABLE", reason: "eBay raw sales are temporarily unavailable." };
    }
}
