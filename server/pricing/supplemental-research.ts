import { cardLanguageStatus } from "../../shared/card-language.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import { observedCardKind, obscuredDisclosedWear } from "../../shared/photo-evidence.ts";
import type { Evaluation } from "../../shared/types.ts";
import { AiSearchAllowanceError, aiSpendingFailure } from "../ai/spending.ts";
import { searchWebPrices } from "../ai/web-price-research.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { provisionalTrackerGrade, trackerMarketReferences } from "./price-tracker.ts";
import { PriceResearchBudgetError } from "./research-budget.ts";

type SupplementalEvidence = Pick<Evaluation, "trackerPriceReference" | "trackerRawReference" | "webPriceResearch" | "supplementalPriceNote">;
type Providers = { tracker: typeof trackerMarketReferences; web: typeof searchWebPrices };
const providers: Providers = { tracker: trackerMarketReferences, web: searchWebPrices };

export async function supplementalResearch(value: Evaluation, options: { cacheOnly: boolean; signal: AbortSignal; now: number },
    sources = providers): Promise<SupplementalEvidence> {
    const result: SupplementalEvidence = {};
    const identity = value.identity, photo = value.photoCheck;
    if (!identity || !readyForPricing(identity) || !identity.name || !identity.cardNumber || !identity.set || identity.notThisCard ||
        !photo || photo.cardCount !== "ONE" || !photo.images.some(p => p.usable && !p.isStockImage) ||
        photo.cardMatch?.verdict === "MISMATCH" || cardLanguageStatus("", [identity.language]) !== "ENGLISH" ||
        !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish) || unsupportedVariantReason(value) ||
        obscuredDisclosedWear(value) || value.frontPhotoStop || value.pricingDeferred ||
        value.condition?.authenticity && value.condition.authenticity.concern !== "NONE_SEEN" ||
        !value.underwriting || value.underwriting.verdict === "NEEDS_REVIEW" || value.underwriting.shippingUnconfirmed) return result;

    const kind = observedCardKind(value), slab = value.slab, raw = value.condition?.rawCondition;
    const provisional = provisionalTrackerGrade(value);
    let market: { grader: string; grade: string };
    let exactCount = 0;
    if (kind === "graded" && slab?.status === "OK" && slab.grader && slab.grade && !slab.gradeQualifier) {
        market = { grader: slab.grader, grade: slab.grade };
        exactCount = value.slabPricing?.summary?.count ?? 0;
    } else if (kind === "raw" && isRawCondition(raw)) {
        market = { grader: "RAW", grade: CONDITION_NAMES[raw] };
        const sameCondition = value.rawPricing?.ebayComps?.find(row => row.grader === "RAW" && row.grade === raw);
        const priced = value.rawPricing?.prices?.find(row => row.condition === raw);
        exactCount = Math.max(sameCondition?.count ?? 0, priced?.comps?.count ?? 0);
    } else if (provisional !== null) {
        market = { grader: "PSA", grade: String(provisional) };
    } else return result;

    const supported = value.underwriting.best?.status === "PRICED";
    const settledPass = supported && value.underwriting.verdict === "PASS";
    // Read saved references for a settled purchase. Spend only where the exact market is sparse.
    const cacheOnly = options.cacheOnly || provisional !== null || settledPass || exactCount >= 3;
    async function lookup<T>(source: string, work: () => Promise<T>) {
        options.signal.throwIfAborted();
        try {
            const data = await work();
            options.signal.throwIfAborted();
            return data;
        } catch (error) {
            options.signal.throwIfAborted();
            if (storageFailure(error) || error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
            const guard = aiSpendingFailure(error);
            if (guard && !(error instanceof AiSearchAllowanceError) && guard.code !== "AI_PAUSED") throw error;
            const message = guard || error instanceof PriceResearchBudgetError
                ? `${source} stopped at the search allowance or spending setting.` : `${source} was unavailable for this check.`;
            result.supplementalPriceNote = [result.supplementalPriceNote, message].filter(Boolean).join(" ");
            return null;
        }
    }
    const tracker = await lookup("Pokémon Price Tracker", () => sources.tracker(value, options.signal, { cacheOnly }));
    if (tracker) Object.assign(result, tracker);
    if (provisional !== null) return result;
    const web = await lookup("Cited web price research", () => sources.web({ cardName: identity.name!, setName: identity.set!, cardNumber: identity.cardNumber!,
        language: identity.language, printingLabel: identity.printingLabel || identity.printing.replaceAll("_", " "),
        finish: identity.finish, ...market }, { signal: options.signal, cacheOnly }));
    if (web) result.webPriceResearch = web;
    return result;
}
