import { CONDITION_NAMES, RAW_CONDITIONS, type RawCondition } from "../../shared/conditions.ts";
import type { CompSummary, Identity, RawPrice, RawPricing } from "../../shared/types.ts";
import { variantFor } from "./raw-prices.ts";
import { printingLabel } from "../identity/card-identity.ts";
import { compProblem, matchesSoldTarget, summarizeComps, uniqueSoldComps } from "./sold-comps.ts";
import type { CheckComps, Comp, FetchRawComps, PricedCard } from "./types.ts";
import type { SoldConditionEvidence, SoldConditionReadStatus } from "../ai/sold-condition.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { MIN_MATCHED_SALES, soldMarketPrice } from "../../shared/sold-evidence.ts";
import { finishClaim } from "../../shared/finish.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";

// Seller condition supports screening and collector references. Resale decisions
// use the separate prices established by inspecting the sold copies.
export { rawConditionClaim as compCondition } from "../../shared/raw-condition-claim.ts";
import { rawConditionClaim as compCondition } from "../../shared/raw-condition-claim.ts";

export async function rawPricesWithSales(card: PricedCard | null, identity: Identity, {
    fetchRawComps, checkComps, now = Date.now(), assessCondition, conditionStatus, acquireCondition, requestedCondition, signal,
}: { fetchRawComps: FetchRawComps; checkComps?: CheckComps; now?: number; assessCondition?: (sale: Comp, identity: Identity, signal?: AbortSignal) => Promise<SoldConditionEvidence | null>;
    conditionStatus?: (sale: Comp, identity: Identity) => SoldConditionReadStatus;
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
        const exact = { printing: identity.printing, setName: variant.setName, cardName: identity.name, cardNumber: identity.cardNumber, finish: variant.finish };
        const eligibleSale = (sale: Comp) => sale.currency === "USD" && sale.sale_type && !sale.grader && !sale.grade &&
            !/\b(psa|cgc|bgs|sgc|tag|lot|bundle)\b/i.test(sale.title) && compProblem({ ...sale, grader: "RAW", grade: "ANY" },
                { ...exact, grader: "RAW", grade: "ANY", now, windowDays: 90 }) === null;
        const target = { name: identity.name!, setName: variant.setName, cardNumber: identity.cardNumber };
        const titleMatches = (sale: Comp) => matchesSoldTarget(sale, target);
        const claimedCondition = (sale: Comp) => {
            if (/\b(?:set of|signed|autographed|altered|proxy|replica)\b|\b\d+\s*(?:cards|pcs)\b/i.test(sale.title)) return null;
            const finish = finishClaim(sale.title);
            return (finish === "NOT_STATED" || finish === variant.finish) &&
                matchesSoldTarget(sale, { ...target, requireTitleIdentity: true }) ? sellerConditionClues({ title: sale.title }).claim : null;
        };
        const readings = new Map<string, Promise<SoldConditionEvidence | null>>();
        let cacheReadFailed = false;
        const readCondition = (sale: Comp) => {
            const key = JSON.stringify([sale.id, sale.listing_url, sale.title]);
            let reading = readings.get(key);
            if (!reading) {
                reading = assessCondition!(sale, identity, signal).catch(() => { signal?.throwIfAborted(); cacheReadFailed = true; return null; });
                readings.set(key, reading);
            }
            return reading;
        };
        const fetched = await fetchRawComps(variant.recordId, variant.name, assessCondition ? { stopWhen: async sales => {
            signal?.throwIfAborted();
            const matching = sales.filter(sale => eligibleSale(sale) && titleMatches(sale));
            if (!requestedCondition) return matching.length > 0;
            const candidates = await Promise.all(matching.map(async sale => {
                const observed = await readCondition(sale);
                if (observed) return observed.condition === requestedCondition;
                const status = conditionStatus?.(sale, identity);
                return status !== "SELLER_CONFLICT" && status !== "OTHER_CARD" && claimedCondition(sale) === requestedCondition;
            }));
            if (cacheReadFailed) throw new Error("Saved sold-copy evidence could not be read during pagination.");
            return candidates.some(Boolean);
        } } : undefined);
        signal?.throwIfAborted();
        let sales = uniqueSoldComps(fetched);
        const sampledSoldCopies = sales.length;
        let sellerConditionComps: CompSummary | undefined;
        let cleanerSellerConditionComps: CompSummary | undefined;
        let titleMatchedSoldCopies = 0, uncertainPhotoReviews = 0, unusableSoldCopies = 0;
        if (assessCondition) {
            const eligible = sales.filter(eligibleSale);
            titleMatchedSoldCopies = eligible.filter(titleMatches).length;
            const accepted = new Map<Comp, SoldConditionEvidence>();
            // This callback reads accepted evidence only. New photo work has
            // a separate, one-shot acquisition after every cache read finishes.
            await Promise.all(eligible.map(async sale => {
                signal?.throwIfAborted();
                const assessed = await readCondition(sale);
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
            if (requestedCondition && !cacheReadFailed) {
                const claims = eligible.map(sale => ({ sale, condition: claimedCondition(sale) }));
                const sellerSummary = (condition: RawCondition) => {
                    const claimed = claims.filter(row => row.condition === condition);
                    const comparable = claimed.filter(({ sale }) => {
                        const observed = accepted.get(sale);
                        const status = conditionStatus?.(sale, identity);
                        return (!observed || observed.condition === condition) && status !== "SELLER_CONFLICT" && status !== "OTHER_CARD";
                    }).map(({ sale }) => ({ ...sale, grader: "RAW", grade: condition, sellerCondition: condition }));
                    const summary = summarizeComps(comparable, { ...exact, grader: "RAW", grade: condition, now, windowDays: 90 });
                    if (claimed.length > comparable.length) summary.dropped["photos contradict the sold title"] = claimed.length - comparable.length;
                    return summary.count ? summary : undefined;
                };
                sellerConditionComps = sellerSummary(requestedCondition);
                if (![...accepted.values()].some(row => row.condition === requestedCondition)) {
                    for (const cleaner of RAW_CONDITIONS.slice(0, RAW_CONDITIONS.indexOf(requestedCondition)).reverse()) {
                        cleanerSellerConditionComps = sellerSummary(cleaner);
                        if (cleanerSellerConditionComps) break;
                    }
                }
            }
            sales = eligible.flatMap(sale => {
                const assessed = accepted.get(sale);
                if (!assessed) {
                    const status = conditionStatus?.(sale, identity);
                    if (status === "REVIEWED" || status === "CORROBORATABLE") uncertainPhotoReviews++;
                    if (status === "UNUSABLE") unusableSoldCopies++;
                }
                return assessed ? [{ ...sale, photoCondition: assessed.condition, conditionEvidence: assessed.evidence, sellerCondition: compCondition(sale.title) }] : [];
            });
        }
        const summaries: CompSummary[] = [];
        for (const condition of RAW_CONDITIONS) {
            signal?.throwIfAborted();
            const criteria = { ...exact, grader: "RAW", grade: condition, now, windowDays: 90 as const };
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
                    : !assessCondition && !titleMatches(original) ? "title does not match target card"
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
            const price = soldMarketPrice(summary);
            if (summary.count >= minimum && price !== null) return [{ condition, price, updatedAt: summary.newestSale, basis: "EBAY_SOLD" as const, comps: summary }];
            return [];
        });
        const atCondition = prices.find(price => price.condition === requestedCondition);
        const lowerCondition = !atCondition && requestedCondition && RAW_CONDITIONS.slice(RAW_CONDITIONS.indexOf(requestedCondition) + 1)
            .find(condition => prices.some(price => price.condition === condition));
        const photoNote = [
            `${titleMatchedSoldCopies} of ${sampledSoldCopies} sold records passed the title and sale checks.`,
            `Photos verified the condition of ${sales.length} sold ${sales.length === 1 ? "copy" : "copies"}.`,
            uncertainPhotoReviews > 0 ? `Photo reviews were inconclusive for ${uncertainPhotoReviews}.` : null,
            unusableSoldCopies > 0 ? `${unusableSoldCopies} had unavailable or unusable listing photos.` : null,
            requestedCondition && !atCondition ? `No verified sale established a ${CONDITION_NAMES[requestedCondition]} price.` : null,
            lowerCondition ? `${CONDITION_NAMES[lowerCondition]} is the closest lower condition with a verified price.` : null,
        ].filter(Boolean).join(" ");
        return { ...market, ...(prices.length ? { status: "PRICED", prices } : {
            status: "PRICE_UNAVAILABLE", reason: "The available eBay sales don't establish a raw resale price for this printing and condition.",
        }), ebayComps: summaries, ...(assessCondition && requestedCondition && {
            sellerConditionComps: sellerConditionComps ?? null, cleanerSellerConditionComps: cleanerSellerConditionComps ?? null }),
            conditionEvidence: assessCondition ? "AI_PHOTOS" : "SELLER_TEXT", reviewedSoldCopies: assessCondition ? sales.length : undefined, sampledSoldCopies,
            evidenceNote: assessCondition ? photoNote
                : "Screening uses seller-stated raw conditions. Final evaluations assess sold-copy photos where available. Up to 40 returned records over 90 days are sampled." };
    } catch {
        signal?.throwIfAborted();
        return { ...market, status: "PRICE_UNAVAILABLE", reason: "eBay raw sales are temporarily unavailable." };
    }
}
