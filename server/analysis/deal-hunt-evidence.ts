import { auctionOpportunity, nextAuctionBid, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../shared/collector-auction.ts";
import { freshListingTime, GRADING_WATCH_FRESH_MS, type GradingOpportunity } from "../../shared/grading-watch.ts";
import type { DealHuntAction, DealHuntGoal } from "../../shared/deal-hunt.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { finishClaim } from "../../shared/finish.ts";
import { finishOfVariant, mapVariantPrintings } from "../identity/card-identity.ts";
import { dollars } from "../../shared/format.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { isUsableRawPrice, photoMatchedRawPrice, referencePriceReason } from "../../shared/money/price-evidence.ts";
import { rawBuyGuidance, rawPriceReferences } from "../../shared/money/raw-buy-guidance.ts";
import { slabBuyGuidance } from "../../shared/money/slab-buy-guidance.ts";
import { acquisitionCost, maxBid } from "../../shared/money/underwriting.ts";
import { verifiedPurchase } from "../../shared/money/verified-purchase.ts";
import { displayedRawGrade, observedCardKind, photoCoverage, slabLabelConfidence } from "../../shared/photo-evidence.ts";
import { huntPrintingCheck, huntPrintingTerms, huntPrintingObservation } from "./deal-hunt-printing.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import type { CompSummary, Evaluation, Grader, PricedPath, Targets } from "../../shared/types.ts";
import type { DealHuntCandidate, DealHuntOutcome } from "./deal-hunt.ts";
import { supplementalMarket } from "../pricing/supplemental-research.ts";
import { configuredShippingZip } from "../ebay/shipping-destination.ts";
import { activityDescription, liquidityIssue } from "./resale-activity.ts";
import { activityForExit, rankHuntMarkets, salesForExit, verifiedRawFloor, type HuntMarket } from "./same-set-markets.ts";

const STALE_PURCHASE_TERMS = "The saved purchase terms need a fresh availability and shipping check.";

function listingTerms(value: Evaluation, now: number) {
    const { price, shipping, availability, termsCheckedAt } = value.listing;
    const age = now - Date.parse(termsCheckedAt ?? "");
    const destinationMatches = (value.listing.shippingDestination ?? null) === configuredShippingZip();
    const total = destinationMatches && price !== null && Number.isFinite(price) && price > 0 && shipping !== null &&
        Number.isFinite(shipping) && shipping >= 0 && !value.underwriting?.shippingUnconfirmed
        ? acquisitionCost(price, shipping, MONEY_CONFIG.buying) : null;
    const status = availability === "UNAVAILABLE" ? "This listing has ended." :
        availability !== "ACTIVE" ? "Availability is unverified." :
        !destinationMatches ? "A current shipping quote is needed for this destination." :
        total === null ? "The delivered purchase total is unverified." :
        !(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS) ? STALE_PURCHASE_TERMS : "";
    const costs = total === null ? "" : `Item ${dollars(price)}, shipping ${dollars(shipping)}, total with estimated tax ${dollars(total)}.`;
    return { total, status, text: [costs, status, termsCheckedAt && `Terms checked ${termsCheckedAt}.`].filter(Boolean).join(" ") };
}

function photos(value: Evaluation, slab: boolean) {
    if (!value.photoCheck) return "There is no saved photo assessment.";
    const coverage = photoCoverage(value.photoCheck);
    const counts = `${value.listing.photosAnalyzed} of ${value.listing.photosInListing} listing photos assessed, including ${coverage.fronts} front and ${coverage.backs} back overviews.`;
    if (slab) {
        const label = slabLabelConfidence(value) ? `The holder confirms ${value.slab?.grader} ${value.slab?.grade}.` : "The holder grade and identity are unconfirmed.";
        return [counts, label, value.slab?.caseCondition === "SCRATCHED" && "The holder has visible scratches."].filter(Boolean).join(" ");
    }
    const grade = displayedRawGrade(value), wear = value.condition?.rawCondition;
    return [counts, isRawCondition(wear) && `Visible condition is ${CONDITION_NAMES[wear]}.`,
        grade?.range.likely ? `Estimated grade ${grade.range.likely} (${grade.confidence.toLowerCase()} confidence).` : "The saved photos did not establish a likely grade.",
        value.condition?.surface?.observations?.[0] || value.condition?.limitations[0]].filter(Boolean).join(" ");
}

// The timestamp and amounts come from matched transactions. Legacy rows without a
// transaction type remain visible in the main evaluation but cannot certify this hunt.
function matchedPrice(summary: CompSummary | null | undefined, now: number) {
    if (!summary?.count || !summary.sales?.some(sale => {
        const age = now - Date.parse(sale.soldAt);
        return ["auction", "fixed_price", "best_offer_accepted"].includes(sale.saleType ?? "") &&
            Number.isFinite(sale.price) && sale.price > 0 && age >= 0 && age <= (summary.windowDays === 180 ? 180 : 90) * 86_400_000;
    })) return null;
    return soldMarketPrice(summary);
}

function gradeMarket(value: Evaluation, grader: Grader, grade: number) {
    const price = value.gradedPricing?.[grader];
    if (!price || !readyForPricing(value.identity) || price.printing !== value.identity?.printing || price.status !== "PRICED") return undefined;
    return price.byGrade?.find(row => row.grader === grader && Number(row.grade) === grade);
}

function rawMarket(value: Evaluation, now: number) {
    const pricing = value.rawPricing;
    if (!readyForPricing(value.identity) || pricing?.status !== "PRICED" || pricing.printing !== value.identity?.printing ||
        !(pricing.finish || pricing.variant) || pricing.variant && finishOfVariant(pricing.variant) !== value.identity?.finish ||
        pricing.finish && pricing.finish !== value.identity?.finish) return null;
    const condition = value.condition?.rawCondition;
    const rawPath = value.underwriting?.paths.find((path): path is PricedPath => path.path === "RAW" && path.status === "PRICED");
    if (rawPath && rawPath.priceCondition !== condition) return verifiedRawFloor(value, rawPath, now)?.row ?? null;
    const row = pricing.prices?.find(row => row.condition === condition && isUsableRawPrice(row));
    if (row?.basis?.startsWith("TCGPLAYER_")) return row;
    const comp = row?.comps ?? pricing.ebayComps?.find(row => row.grader === "RAW" && row.grade === condition);
    return row && comp?.grade === condition && comp?.grader === "RAW" && matchedPrice(comp, now) === row.price ? row : null;
}

function slabMarket(value: Evaluation, now: number) {
    const pricing = value.slabPricing, summary = pricing?.summary;
    if (!verifiedSlabMarketKey(value, { allowScratchedCase: true }) || !pricing || !summary ||
        pricing.status !== "PRICED" || pricing.printing !== value.identity?.printing ||
        pricing.grader !== value.slab?.grader || String(pricing.grade) !== value.slab?.grade ||
        summary.grader !== value.slab?.grader || String(summary.grade) !== value.slab?.grade) return null;
    const price = matchedPrice(summary, now);
    return price === null ? null : { price, count: summary.count };
}

function gradeScenarios(value: Evaluation, now: number) {
    const grade = value.condition?.gradeRange?.likely;
    if (!grade) return [];
    return (value.underwriting?.paths ?? []).flatMap(path => {
        if (path.path !== "GRADE" || path.status !== "PRICED" || !path.grader || referencePriceReason(value, path)) return [];
        const grader = path.grader;
        const at = (number: number) => {
            const summary = gradeMarket(value, grader, number);
            const estimate = matchedPrice(summary, now);
            const row = path.outlook?.find(row => row.grade === number && row.filledFrom === null && row.price === estimate);
            return row ? { grade: number, profit: (cents(row.net) - cents(path.cost)) / 100 } : null;
        };
        return [{ path, likely: at(grade), lower: at(grade - 1) }];
    });
}

function gradeItemLimit(path: PricedPath, likelyProfit: number, lowerProfit: number, likelyTargets: Targets = { minProfit: 0, minRoi: 0 }) {
    const capAt = (profit: number, targets: Targets) => maxBid({ expectedNet: (cents(path.cost) + cents(profit)) / 100,
        fixedCosts: path.fixedCosts, shipping: path.shipping }, { ...MONEY_CONFIG, targets });
    return Math.min(path.maxBid, capAt(likelyProfit, likelyTargets), capAt(lowerProfit, { minProfit: 0, minRoi: 0 }));
}

type Scenarios = ReturnType<typeof gradeScenarios>;
function gradeMath(scenarios: Scenarios, value: Evaluation, now: number) {
    if (!scenarios.length) {
        const grade = displayedRawGrade(value)?.range.likely;
        const { total } = listingTerms(value, now);
        const purchase = total === null ? "this copy" : `this copy at ${dollars(total)} delivered`;
        if (!grade) return `Pass on grading ${purchase}. The photos do not establish a likely grade to price.`;
        const grades = grade > 1 ? `grade ${grade} and grade ${grade - 1}` : "grade 1";
        return `Pass on grading ${purchase}. The photos suggest grade ${grade}. The available sales and grading costs do not establish a profitable resale at ${grades}.`;
    }
    return scenarios.map(({ path, likely, lower }) => {
        const render = (label: string, scenario: typeof likely) => scenario
            ? `${label} (${path.grader} ${scenario.grade}), the projected ${scenario.profit < 0 ? "loss" : "profit"} is ${dollars(Math.abs(scenario.profit))} after all costs.`
            : `${label}, the saved sales do not support a profit estimate.`;
        return [`${path.grader} grading and submission shipping add ${dollars(path.fixedCosts)}.`,
            render("At the likely grade", likely), render("One grade lower", lower)].join(" ");
    }).join(" ");
}

function huntSlabReference(value: Evaluation, now: number) {
    const identity = value.identity, grade = value.slab;
    if (!identity || !grade) return null;
    const web = value.webPriceResearch, scope = web?.market;
    const webAge = now - Date.parse(web?.checkedAt ?? "");
    const matchesWeb = scope && scope.cardName === identity.name && scope.setName === identity.set && scope.cardNumber === identity.cardNumber &&
        scope.grader === grade.grader && scope.grade === grade.grade && scope.finish === identity.finish && scope.language === identity.language &&
        scope.printingLabel === (identity.printingLabel || identity.printing.replaceAll("_", " ")) && webAge >= 0 && webAge <= 7 * 86_400_000;
    const label = value.trackerPriceReference?.printingLabel;
    const finish = finishClaim(label);
    const matchesTracker = label && mapVariantPrintings([label], identity.set)[label] === identity.printing &&
        (finish === "NOT_STATED" ? "NON_HOLO" : finish) === identity.finish;
    return slabBuyGuidance({ ...value, trackerPriceReference: matchesTracker ? value.trackerPriceReference : undefined,
        webPriceResearch: matchesWeb ? web : undefined }, now);
}

// References explain what a thin market may be worth. They never enter underwriting or the liquidity count.
export function huntReferenceEvidence(value: Evaluation, now: number): string | null {
    const slab = huntSlabReference(value, now);
    if (slab) return `Estimated ${slab.grade} market value ${dollars(slab.price)}. ${slab.evidence}`;
    const identity = value.identity, wear = value.condition?.rawCondition;
    if (!identity || !isRawCondition(wear) || observedCardKind(value) !== "raw") return null;
    const { tracked, web, scopedWeb, recent } = rawPriceReferences(value, now, wear, identity);
    const sales = scopedWeb && web?.observations.filter(row => row.kind === "SOLD" && row.url && row.priceUsd > 0 && recent(row.date, 90));
    if (sales && sales.length) {
        const latest = sales.slice().sort((a, b) => b.date!.localeCompare(a.date!))[0];
        return `The latest cited seller-described ${CONDITION_NAMES[wear]} sale was ${dollars(latest.priceUsd)} on ${latest.date}. The sold copy’s condition has not been photo-verified.`;
    }
    if (tracked && tracked.condition === wear) return `Pokémon Price Tracker reports a ${dollars(tracked.priceUsd)} TCGplayer market estimate for ${CONDITION_NAMES[wear]} on ${tracked.updatedAt.slice(0, 10)}.`;
    return null;
}

function liquidityNote(sales: number) {
    if (!sales) return "Liquidity is unverified for this resale route.";
    return sales < 3 ? "Liquidity confidence is low with this small sample." : "";
}

// Find a flip can use asks to prioritize research. Only a supported exit
// belongs in the profit calculation, including on older saved evaluations.
export function flipResaleEvidence(value: Evaluation, goal: DealHuntGoal, targets: Targets): Evaluation {
    const raw = value.rawPricing;
    if (goal !== "resell" || !raw?.prices?.some(row => row.basis?.startsWith("TCGPLAYER_"))) return value;
    const comparison = raw.prices.find(row => row.condition === value.condition?.rawCondition &&
        row.basis?.startsWith("TCGPLAYER_") && isUsableRawPrice(row))?.offers;
    const prices = raw.prices.flatMap(row => {
        if (!row.basis?.startsWith("TCGPLAYER_")) {
            return raw.conditionEvidence === "AI_PHOTOS" || photoMatchedRawPrice(row.comps, row.condition) === row.price ? [row] : [];
        }
        const comps = raw.ebayComps?.find(s => s.grader === "RAW" && s.grade === row.condition);
        const price = photoMatchedRawPrice(comps, row.condition);
        return price === null || !comps ? [] : [{ condition: row.condition, price, comps, updatedAt: comps.newestSale, basis: "EBAY_SOLD" as const }];
    });
    return retargetEvaluation({ ...value, rawPricing: { ...raw, prices, tcgplayerComparison: comparison,
        ...(prices.length ? { status: "PRICED", conditionEvidence: "AI_PHOTOS" } : {
            status: "PRICE_UNAVAILABLE", reason: "The TCGplayer quote shows current competition. A matched resale price is still needed." }) } }, targets);
}

export function dealHuntCandidate(value: Evaluation, goal: DealHuntGoal, clock: number | (() => number) = Date.now, market?: HuntMarket | HuntMarket[], targets: Targets = MONEY_CONFIG.targets,
    maxDelivered?: number, { preferRecentSales = false, hasGuideSales = false, requireLiquid = false }: { preferRecentSales?: boolean; hasGuideSales?: boolean; requireLiquid?: boolean } = {}): DealHuntCandidate | null {
    value = flipResaleEvidence(value, goal, targets);
    const timestamp = typeof clock === "number" ? () => clock : clock;
    const kind = observedCardKind(value);
    const auction = value.listing.buyingOption === "AUCTION";
    if (!kind ||
        (goal === "grade_raw" && kind !== "raw") || (goal === "collect_slab" && kind !== "graded")) return null;
    const slab = kind === "graded";
    const grade = value.condition?.gradeRange?.likely;
    const gradeRoute = goal === "grade_raw" || (!slab && value.underwriting?.best?.path === "GRADE");
    const requiresLiquidity = preferRecentSales && goal === "resell";
    function canCheckReferences(completed: ReadonlySet<DealHuntAction>, now: number) {
        const hasSoldLeads = goal === "resell" && (hasGuideSales || value.webPriceResearch?.observations.some(row => row.kind === "SOLD"));
        if (!completed.has("check_sales") || !completed.has("inspect_photos") || !completed.has("check_listing") ||
            goal === "grade_raw" || listingTerms(value, now).status ||
            value.listing.endTime && Date.parse(value.listing.endTime) <= now ||
            value.deeperPhotoReview?.findings.some(f => f.impact === "NEW_CONCERN") ||
            slab && !verifiedSlabMarketKey(value, { allowScratchedCase: true })) return false;
        const thinExit = requireLiquid && outcome(new Set([...completed, "check_raw_resale", "calculate_grading"]))?.liquidityIssue;
        if (!thinExit && ((value.underwriting?.verdict !== "CANT_PRICE" &&
            !(value.rawPricing?.tcgplayerComparison && value.underwriting?.verdict === "PASS")) ||
            (slab ? slabMarket(value, now) : rawMarket(value, now)) ||
            (!value.rawPricing?.tcgplayerComparison && !hasSoldLeads && huntReferenceEvidence(value, now)))) return false;
        const target = supplementalMarket(value);
        if (!target || target.provisional !== null) return false;
        const item = auction ? nextAuctionBid(value.listing, now) : value.listing.price;
        if (item === null || auction && !withinOpportunityWindow(value.listing.endTime, now)) return false;
        return maxDelivered === undefined || acquisitionCost(item, value.listing.shipping!, MONEY_CONFIG.buying) <= maxDelivered;
    }
    function checkedReferences(now: number) {
        return [huntReferenceEvidence(value, now) ?? "No additional source supplied a current estimate or cited sale for this exact market.",
            value.supplementalPriceNote].filter(Boolean).join(" ");
    }
    function saleEvidence(now: number) {
        const slabSales = slab ? slabMarket(value, now) : null;
        const reference = slab && !slabSales ? huntSlabReference(value, now) : null;
        const raw = slab ? null : rawMarket(value, now);
        if (slabSales) return `${slabSales.count} matched ${value.slab?.grader} ${value.slab?.grade} sales. Sold estimate ${dollars(slabSales.price)}.`;
        if (reference) return `${reference.evidence} Estimated market value ${dollars(reference.price)}. ${reference.caseNote ?? ""}`.trim();
        if (slab) return "No recent sales verified for this printing, grader and grade.";
        const observations = raw ? [raw.basis?.startsWith("TCGPLAYER_")
            ? `Condition-matched TCGplayer estimate ${dollars(raw.price)}. Current offers are price evidence, not completed sales.`
            : `Condition-matched raw sale estimate ${dollars(raw.price)}.`] : [];
        if (value.rawPricing?.tcgplayerComparison) {
            const quote = value.rawPricing.tcgplayerComparison;
            const lowest = quote.offers.length ? Math.min(...quote.offers.map(o => o.total)) : null;
            observations.push(lowest !== null ? `The lowest ${quote.marketCondition} TCGplayer ask is ${dollars(lowest)} with shipping.`
                : `TCGplayer reports a ${quote.marketCondition} market estimate of ${dollars(quote.price)}.`);
            if (!raw) observations.push("A matched completed sale is needed to price this flip.");
        }
        if (!raw) {
            const guidance = rawBuyGuidance(value, now, targets);
            if (guidance) observations.push(guidance.explanation);
        }
        if (grade) for (const grader of ["PSA", "CGC"] as const) {
            for (const number of [grade, grade - 1]) {
                const summary = gradeMarket(value, grader, number);
                const estimate = matchedPrice(summary, now);
                if (estimate !== null && summary) observations.push(`The ${grader} ${number} estimate is ${dollars(estimate)} from ${summary.count} matched sales.`);
            }
        }
        if (!observations.length && value.identity?.status === "IDENTIFIED" && value.photoCheck && !isRawCondition(value.condition?.rawCondition)) {
            return "The photos identify the card, but its condition is unclear. A condition-matched resale value and buy limit are unavailable.";
        }
        return observations.join(" ") || "No matching raw or grade-specific sales have been verified.";
    }
    function rawExit(now: number) {
        const price = rawMarket(value, now);
        const path = value.underwriting?.paths.find((p): p is PricedPath => p.status === "PRICED" && p.path === "RAW");
        if (!price || !isRawCondition(price.condition) || !path || path.salePrice !== price.price || path.priceCondition !== price.condition || referencePriceReason(value, path)) return null;
        const markets = rankHuntMarkets([value], null, "resell", "any_card", now);
        if (market) markets.push(...(Array.isArray(market) ? market : [market]));
        const sales = salesForExit(value, path, markets, now);
        return { path, price, condition: price.condition, sales };
    }
    function rawEstimate(price: NonNullable<ReturnType<typeof rawMarket>>) {
        const condition = price.condition;
        return isRawCondition(condition) && condition !== value.condition?.rawCondition
            ? `the photo-checked ${CONDITION_NAMES[condition]} resale floor of ${dollars(price.price)}`
            : `the condition-matched ${dollars(price.price)} estimate`;
    }
    function rawObservation(now: number) {
        const exit = rawExit(now);
        if (!exit) return "The saved sales do not establish a condition-matched raw resale for this copy.";
        const next = auction ? nextAuctionBid(value.listing, now) : value.listing.price;
        const shipping = value.listing.shipping;
        if (next === null || shipping === null) return "Fresh purchase and shipping terms are needed to calculate raw resale profit.";
        const total = acquisitionCost(next, shipping, MONEY_CONFIG.buying);
        const profit = (cents(exit.path.expectedNet) - cents(total) - cents(exit.path.fixedCosts)) / 100;
        const estimate = exit.condition === value.condition?.rawCondition
            ? `the ${CONDITION_NAMES[exit.condition]} estimate of ${dollars(exit.price.price)}` : rawEstimate(exit.price);
        return `Selling raw at ${estimate} projects a ${profit < 0 ? "loss" : "profit"} of ${dollars(Math.abs(profit))} after all costs${auction ? " at the next bid" : ""}. ${exit.sales} observed matching ${exit.sales === 1 ? "sale" : "sales"} in the last 60 days.`;
    }
    function outcome(completed: ReadonlySet<DealHuntAction>, previewTermsRefresh = false): DealHuntOutcome | null {
        if (!completed.has("check_listing") || !completed.has("inspect_photos")) return null;
        const now = timestamp();
        if (!completed.has("resolve_printing") && huntPrintingCheck(value) && huntPrintingTerms(value.listing, now, maxDelivered)) return null;
        const release = value.identity?.notThisCard || releaseIssue(value);
        if (release) return { decision: "WAIT", section: "photos", reason: release };
        const rawChecked = goal === "resell" && !slab && completed.has("check_raw_resale");
        if (auction) {
            if (!withinOpportunityWindow(value.listing.endTime, now)) return { decision: "WAIT", section: "sales", reason: "The auction is outside the remaining ten-hour opportunity window." };
            if ((value.listing.shippingDestination ?? null) !== configuredShippingZip()) return { decision: "WAIT", section: "sales", reason: "A current shipping quote is needed for this destination." };
            if (!completed.has("check_sales") && !rawChecked) return null;
            if (goal === "collect_slab") {
                const bid = collectorAuction(value, now, maxDelivered);
                const reference = completed.has("check_price_references") ? checkedReferences(now) : huntReferenceEvidence(value, now);
                return { decision: bid?.status === "BID" ? "BID" : "WAIT", section: "sales", reason: bid?.reason ??
                    [reference, "Wait. Current auction terms and verified sales for this printing, grader and grade are needed to set your collector bid limit."].filter(Boolean).join(" ") };
            }
            const offer = auctionOpportunity(value, targets, now, maxDelivered);
            if (!offer) {
                const reference = completed.has("check_price_references") ? checkedReferences(now) : huntReferenceEvidence(value, now);
                return { decision: "WAIT", section: "sales", reason: [reference,
                    "The latest bid and matched sales did not establish a current below-market auction for this copy."].filter(Boolean).join(" ") };
            }
            if (!completed.has("check_sales") && offer.routeKind !== "RAW") return null;
            if ((offer.routeKind === "GRADE" || goal === "grade_raw") && !completed.has("calculate_grading")) return null;
            if (goal === "grade_raw" && offer.routeKind !== "GRADE") return { decision: "WAIT", section: "grading", reason: "A profitable grading route at the next bid has not been established." };
            const recentSales = offer.exitSales60 ?? offer.exitSales30;
            const section = offer.routeKind === "GRADE" ? "grading" : "sales";
            const path = value.underwriting?.paths.find((p): p is PricedPath => p.status === "PRICED" && p.path === offer.routeKind &&
                (p.path !== "GRADE" || p.grader === offer.grading?.grader));
            const activity = requiresLiquidity && path && activityForExit(value, path, rankHuntMarkets([value], null, "resell", "any_card", now), now).activity;
            const thin = requireLiquid && offer.status === "BID" && liquidityIssue(activity || undefined);
            if (thin) return { decision: "WAIT", section, recentSales, liquidityIssue: thin, reason: [thin, activity && activityDescription(activity)].filter(Boolean).join(" ") };
            if (requiresLiquidity && recentSales === 0) return { decision: "WAIT", section, recentSales,
                reason: liquidityNote(recentSales) + " No matching sales for this resale route were observed in the last 60 days." };
            return { decision: offer.status === "BID" ? "BID" : "WAIT",
                section, reason: [offer.reason, requiresLiquidity && `${recentSales} matching ${recentSales === 1 ? "sale" : "sales"} observed in the last 60 days.`,
                    activity && activityDescription(activity), requiresLiquidity && liquidityNote(recentSales)].filter(Boolean).join(" "),
                recentSales, ...(activity && { resalePriority: activity.priority }) };
        }
        if (!slab && !readyForPricing(value.identity)) {
            const status = value.listing.availability === "UNAVAILABLE" ? "The listing has ended. " : "";
            return { decision: "WAIT", section: "photos", reason: status + "The photos did not establish the exact printing needed to price this copy." };
        }
        const raw = rawChecked ? rawExit(now) : null;
        const chooseRaw = raw && raw.path.clears && raw.path.profit > 0 &&
            (!completed.has("calculate_grading") || !gradeRoute);
        if (!chooseRaw && (!completed.has("check_sales") || gradeRoute && !completed.has("calculate_grading"))) return null;
        let section: DealHuntOutcome["section"] = gradeRoute && !chooseRaw ? "grading" : "sales";
        let hasGradeComparisons = false;
        const terms = listingTerms(value, now);
        const slabSales = slab ? slabMarket(value, now) : null;
        const reference = slab && !slabSales ? huntSlabReference(value, now) : null;
        const markets = goal === "resell" ? rankHuntMarkets([value], null, goal, "any_card", now) : [];
        if (market) markets.push(...(Array.isArray(market) ? market : [market]));
        let exit: PricedPath | undefined;
        let reviewedLimit: number | undefined;
        let reason: string;
        let supported = false;
        if (goal === "collect_slab") {
            const price = slabSales?.price ?? reference?.price;
            reason = price && terms.total !== null ? `The estimated purchase total is ${dollars(terms.total)} against ${dollars(price)} ${slabSales ? "from matched sales" : "from the market reference"}.` : saleEvidence(now);
            if (!slabSales && reference) reason += " An individual matched transaction is still needed for a buy.";
            const intact = !!verifiedSlabMarketKey(value);
            if (slabSales && !intact) reason += " The holder condition limits a direct price comparison.";
            supported = !!slabSales && intact && terms.total !== null && cents(terms.total) <= cents(slabSales.price) &&
                !!value.underwriting && value.underwriting.verdict !== "NEEDS_REVIEW" &&
                !value.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN");
        } else if (chooseRaw) {
            exit = raw.path;
            supported = value.underwriting?.verdict.startsWith("BUY") === true;
            reason = `Selling raw at ${rawEstimate(raw.price)} projects ${dollars(exit.profit)} after purchase and selling costs.`;
        } else if (gradeRoute) {
            const scenarios = gradeScenarios(value, now);
            hasGradeComparisons = scenarios.some(({ likely, lower }) => likely && lower);
            const profitable = scenarios.filter(({ path, likely, lower }) => path.clears && path.profit > 0 && likely && likely.profit > 0 && lower && lower.profit > 0 &&
                meetsMoneyTargets(cents(path.cost) + cents(likely.profit), cents(path.cost), targets.minProfit, targets.minRoi));
            const viable = profitable[0];
            exit = (viable ?? scenarios.find(({ path }) => path.profit > 0))?.path;
            if (viable?.likely && viable.lower) reviewedLimit = gradeItemLimit(viable.path, viable.likely.profit, viable.lower.profit, targets);
            reason = gradeMath(viable ? [viable] : scenarios, value, now);
            supported = !!viable && value.underwriting?.verdict.startsWith("BUY") === true;
            if (!supported && goal === "resell" && value.underwriting?.verdict.startsWith("BUY")) {
                const raw = rawMarket(value, now);
                const rawPath = value.underwriting.paths.find((path): path is PricedPath => path.path === "RAW" && path.status === "PRICED");
                if (raw && rawPath?.clears && rawPath.profit > 0 && rawPath.salePrice === raw.price && !referencePriceReason(value, rawPath)) {
                    supported = true;
                    exit = rawPath;
                    section = "sales";
                    reason = `Selling this copy raw at ${rawEstimate(raw)} projects ${dollars(rawPath.profit)} after purchase and selling costs.`;
                }
            }
            if (!supported && scenarios.some(({ path, likely }) => likely && likely.profit > 0 &&
                !meetsMoneyTargets(cents(path.cost) + cents(likely.profit), cents(path.cost), targets.minProfit, targets.minRoi))) {
                reason += " The likely-grade return falls short of your profit or ROI target.";
            }
        } else {
            const raw = slab ? null : rawMarket(value, now);
            const path = value.underwriting?.best;
            exit = path ?? undefined;
            supported = !!path && ((!!raw && path.path === "RAW") || (!!slabSales && path.path === "GRADED_RESALE")) &&
                path.clears && path.profit > 0 && !referencePriceReason(value, path) && value.underwriting?.verdict.startsWith("BUY") === true;
            reason = path && raw ? `Selling raw at ${rawEstimate(raw)} projects ${dollars(path.profit)} after purchase and selling costs.` :
                path && slabSales ? `${path.label} projects ${dollars(path.profit)} after purchase and selling costs.` :
                reference ? `${reference.explanation} ${reference.evidence}` : saleEvidence(now);
        }
        const resale = goal === "resell" && exit ? activityForExit(value, exit, markets, now) : null;
        const recentSales = resale?.count ?? null;
        if (recentSales !== null && exit) {
            const label = exit.path === "RAW" && exit.priceCondition ? `${CONDITION_NAMES[exit.priceCondition]} raw` :
                exit.path === "GRADE" ? `${exit.grader} ${grade}` : `${value.slab?.grader} ${value.slab?.grade}`;
            reason += ` ${recentSales} observed matching ${label} ${recentSales === 1 ? "sale" : "sales"} in the last 60 days.`;
            if (resale?.activity) reason += " " + activityDescription(resale.activity);
            if (requiresLiquidity) {
                supported &&= recentSales > 0;
                const note = liquidityNote(recentSales);
                if (note) reason += " " + note;
            } else if (!recentSales) reason += " The returned evidence supplies no matching transactions in that window; a price quote alone does not establish sales activity.";
            if (exit.profit > 0 && !exit.clears) reason += " The projected return falls short of your profit or ROI target.";
        }
        const thin = requireLiquid && exit?.clears && exit.profit > 0 && liquidityIssue(resale?.activity);
        if (thin) {
            supported = false;
            reason += " " + thin;
        }
        if (!supported && completed.has("check_price_references") && !reference) {
            reason = [checkedReferences(now), reason].join(" ");
        }
        if (reference && !supported && !reason.includes(reference.evidence)) reason += " " + reference.evidence;
        const stalePrices = supported && !currentPriceEvidence(value, now);
        const seller = value.listing.seller;
        const sellerConcern = !!seller && ((seller.feedbackScore != null && seller.feedbackScore < 10) ||
            (seller.feedbackPercentage != null && seller.feedbackPercentage < 98));
        // This private preview only decides whether another terms read is useful.
        // It never authorizes a purchase: the public outcome below remains strict,
        // and availability, destination, prices and all other safeguards still apply.
        const termsCaution = previewTermsRefresh && terms.status === STALE_PURCHASE_TERMS ? "" : terms.status;
        const cautions = [termsCaution, stalePrices && "The market prices need updating.", sellerConcern && "The seller has limited or low feedback."].filter(Boolean);
        const purchase = exit && supported && cautions.length === 0 ? verifiedPurchase(value, exit, targets, reviewedLimit) : undefined;
        return { decision: supported && cautions.length === 0 && (goal === "collect_slab" || purchase) ? "BUY" : "WAIT",
            reason: [reason, ...cautions].join(" "), section, ...(thin && { liquidityIssue: thin }), ...(purchase && { verifiedPurchase: purchase }),
            ...(requiresLiquidity && recentSales !== null && { recentSales, resalePriority: resale?.activity?.priority }),
            alternateSections: section === "grading" && hasGradeComparisons ? ["sales"] : undefined };
    }
    const canRefreshTerms = (completed: ReadonlySet<DealHuntAction>) => !auction && completed.has("check_listing") &&
        listingTerms(value, timestamp()).status === STALE_PURCHASE_TERMS && outcome(completed, true)?.decision === "BUY";
    return {
        listingId: value.listing.id, title: value.listing.title,
        summary: [slab ? "Graded card" : "Raw card", huntPrintingCheck(value) && "One set-specific original photo detail can resolve the printing.", value.listing.cardCondition && `seller describes it as ${value.listing.cardCondition}`,
            value.listing.listedAt ? `first available ${value.listing.listedAt}` : value.listing.createdAt && `created ${value.listing.createdAt}`].filter(Boolean).join(" · "),
        available(completed) {
            const refreshTerms = canRefreshTerms(completed);
            const actions: DealHuntAction[] = ["check_listing", "inspect_photos", "check_sales"];
            if (completed.has("check_listing") && huntPrintingCheck(value) && huntPrintingTerms(value.listing, timestamp(), maxDelivered)) actions.push("resolve_printing");
            if (goal === "resell" && !slab && readyForPricing(value.identity) && isRawCondition(value.condition?.rawCondition))
                actions.push("check_raw_resale");
            if (canCheckReferences(completed, timestamp())) actions.push("check_price_references");
            if (!slab && completed.has("inspect_photos") && completed.has("check_sales")) actions.push("calculate_grading");
            return actions.filter(action => !completed.has(action) || action === "check_listing" && refreshTerms);
        },
        canRepeat: (action, completed) => action === "check_listing" && canRefreshTerms(completed),
        read(action) {
            const now = timestamp();
            switch (action) {
                case "check_listing": {
                    if (!auction) return listingTerms(value, now).text;
                    const { price, endTime, auctionQuote } = value.listing;
                    return [price != null && `Current auction price ${dollars(price)}.`, auctionQuote?.minimumBid != null && `Next bid ${dollars(auctionQuote.minimumBid)}.`, endTime && `Ends ${endTime}.`].filter(Boolean).join(" ") || "Auction terms are unavailable.";
                }
                case "inspect_photos": return photos(value, slab);
                case "resolve_printing": return huntPrintingObservation(value);
                case "check_raw_resale": return rawObservation(now);
                case "move_on": return "Continue checking other listings.";
                case "verify_sold_listing":
                case "check_sales": return saleEvidence(now);
                case "check_price_history": return "Daily history requires an exact market lookup.";
                case "compare_cardmarket": return "Active EU offers require an exact Cardmarket lookup.";
                case "check_price_tracker":
                case "search_web_sales":
                case "check_price_references": return checkedReferences(now);
                case "calculate_grading": {
                    if (!auction) return gradeMath(gradeScenarios(value, now), value, now);
                    const grading = auctionOpportunity(value, targets, now, maxDelivered)?.grading;
                    return grading ? `At the next bid, ${grading.grader} ${grading.likelyGrade} projects ${dollars(grading.likelyProfit)} profit and ${grading.grader} ${grading.lowerGrade} projects ${dollars(grading.lowerProfit)}. Grading and submission add ${dollars(grading.gradingCosts)}.`
                        : "The next bid and grade-specific sales did not support a grading opportunity.";
                }
            }
        },
        outcome: completed => outcome(completed),
    };
}

// The buyer reviewer calls this with its existing evidence. Checking a watch
// never starts a second price lookup or photo assessment.
export function newGradingOpportunity(value: Evaluation, now: number, targets: Targets, dates: Pick<Evaluation["listing"], "listedAt" | "createdAt"> = value.listing): GradingOpportunity | undefined {
    const listed = freshListingTime(dates, now);
    const terms = listingTerms(value, now);
    if (listed === null || terms.status || terms.total === null || Date.parse(value.listing.endTime ?? "") <= now ||
        !value.photoCheck || value.condition?.authenticity.concern !== "NONE_SEEN" || value.condition.creases === "SUSPECTED" ||
        value.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN") ||
        !value.underwriting?.verdict.startsWith("BUY")) return;
    const coverage = photoCoverage(value.photoCheck);
    if (!coverage.fronts || !coverage.backs) return;
    const checked = dealHuntCandidate(value, "grade_raw", now, undefined, targets)?.outcome(new Set(["check_listing", "inspect_photos", "check_sales", "calculate_grading"]));
    if (checked?.decision !== "BUY") return;
    const markets = rankHuntMarkets([value], null, "resell", "any_card", now, true);
    for (const { path, likely, lower } of gradeScenarios(value, now).sort((a, b) => b.path.profit - a.path.profit)) {
        if (!path.grader || !path.clears || path.profit <= 0 || !likely || likely.profit <= 0 || !lower || lower.profit <= 0) continue;
        if (!meetsMoneyTargets(cents(path.cost) + cents(likely.profit), cents(path.cost), targets.minProfit, targets.minRoi)) continue;
        const marketAt = (grade: number) => markets.find(m => m.kind === "raw" && m.grader === path.grader && m.grade === grade);
        const high = marketAt(likely.grade), low = marketAt(lower.grade);
        if (!high || !low) continue;
        const validUntil = Math.min(Date.parse(value.listing.termsCheckedAt!) + BEST_BUY_TERMS_MAX_AGE_MS,
            listed + GRADING_WATCH_FRESH_MS,
            Date.parse(value.listing.endTime ?? "") || Infinity);
        if (!(validUntil > now)) continue;
        const purchase = verifiedPurchase(value, path, targets, gradeItemLimit(path, likely.profit, lower.profit, targets));
        if (!purchase) continue;
        return { grader: path.grader, listingDate: new Date(listed).toISOString(), dateSource: dates.listedAt ? "listed" : "created", validUntil, delivered: terms.total,
            verifiedPurchase: purchase,
            gradingCosts: path.fixedCosts, likely: { ...likely, sales30: high.sales30, sales60: high.sales60 ?? high.sales30 },
            lower: { ...lower, sales30: low.sales30, sales60: low.sales60 ?? low.sales30 } };
    }
}
