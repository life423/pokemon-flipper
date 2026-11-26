import { validShippingZip } from "../../shared/shipping-zip.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { dollars, percent } from "./format";
import { prefersReducedMotion, transitionName, withViewTransition } from "./motion";
import type { EbayUsage, Evaluation, ListingSummary, Targets } from "./types";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import type { AiUsageDay } from "../../shared/ai-usage.ts";
import type { SearchContinuation } from "../../shared/search-continuation.ts";
import { fetchAiUsage, fetchShippingDestination, ApiRequestError } from "./api";
import { analysisConcurrency } from "../../shared/analysis.ts";
import { matchesListingFilters, withinAutomaticAuctionWindow } from "../../shared/listing-filters.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import type { ListingFilters, MarketplaceOrder } from "../../shared/listing-filters.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { BOUNDED_AUTO_CONCURRENCY, DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { looksLikeListingLink, parseListingLink } from "../../shared/listing-link.ts";
import { evaluatedIdentityMismatch, withResolvedCriteria } from "../../shared/search-criteria.ts";
import { applyPricingRetry, PRICING_RETRY_LIMIT } from "../../shared/pricing-retries.ts";
import { MAX_OFFER_DISCOUNT_PERCENT } from "../../shared/money/cents.ts";
import { priceEvidenceGap } from "../../shared/money/price-evidence.ts";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";
import { applyVerifiedPurchase, PURCHASE_RECHECK_MESSAGE } from "../../shared/money/verified-purchase.ts";
import { isLegacyAiAccountingFailure } from "../../shared/wait-skip-review.ts";
import { evaluateListing, fetchEbayUsage, fetchSetYears, reviewListingPhotos, streamDeals, streamNewDeals, interpretSearchRequest, newWatchScanId, restoreWatchBudget, fetchShortlist, saveListing, removeSavedListing, updateSavedListing, refreshSavedListings, resolveListingLink, retryPricingBatch, saveSearchDiagnostic, type DealsMessage } from "./api";
import type { ShortlistEntry } from "../../shared/shortlist.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { ShortlistView } from "./components/ShortlistView";
import { AuctionSniper, type SniperDraft } from "./components/AuctionSniper";
import { CameraGrade } from "./components/CameraGrade";
import { AiBudgetStatus } from "./components/AiBudgetStatus";
import { PriceResearchStatus } from "./components/PriceResearchStatus";
import { ProviderUsageNotice } from "./components/ProviderUsageNotice";
import type { DeeperReviewState } from "./components/PhotoReview";
import { DealCard } from "./components/DealCard";
import { BestCurrentBuy, LowestListedCopy, RawCopyComparison } from "./components/BestCurrentBuy";
import { CollectorStrategy } from "./components/CollectorStrategy";
import { AuctionTracking } from "./components/AuctionTracking";
import { AuctionOpportunities } from "./components/AuctionOpportunities";
import type { HuntGoalPrompt } from "./search/hunt-goal";
import type { SearchPlan } from "../../shared/search-plan.ts";
import { currentHuntBid, expiredGradingReason, reconcileHuntListing, supportsCrossCardHunt } from "./search/hunt-result";
import { GradingWatch } from "./components/GradingWatch";
import { GuidedFlip } from "./components/GuidedFlip";
import { readFlipSession } from "./search/flip-session";
import { DealHunt } from "./components/DealHunt";
import { SHIPPING_DESTINATION_REVISION, SHIPPING_DESTINATION_SAVED } from "./components/ShippingDestination";
import type { DealHuntReport, DealHuntResponse, DealHuntScope } from "../../shared/deal-hunt.ts";
import { ResaleReceiptMatches } from "./components/ResaleReceipts";
import { CompetingAuctions } from "./components/CompetingAuctions";
import { CollectorFinds } from "./components/CollectorFinds";
import { PricingRetries } from "./components/PricingRetries";
import { EmptyState } from "./components/EmptyState";
import { SearchProgress, type SearchPhase } from "./components/SearchProgress";
import { SearchReview } from "./components/SearchReview";
import {
    ArrowIcon,
    ClockIcon,
    CloseIcon,
    SearchIcon,
} from "./components/Icons";
import { DetailPanel } from "./components/DetailPanel";
import { useNow } from "./useNow";
import { useMediaQuery } from "./useMediaQuery";
import { useBuyerReviews } from "./search/useBuyerReviews";
import { listingEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import { SearchControls, SearchOptions } from "./search/SearchControls";
import { SearchCoverage } from "./search/SearchCoverage";
import { matchesContinuationDestination, readContinuationSession, writeContinuationSession, type ContinuationRequest, type ContinuationSession } from "./search/continuation-session";
import { displayAnalysis, type AnalysisState, type PriceRefreshState } from "./analysis-state";
import { evaluationOf, filterSearchResults, groupSearchResults, sortSearchResults, countSearchResults, buyingComparisonRows, lowestListedCopy, selectDealAlternatives, rankCurrentBuys, rankRawBuyingComparisons, competitionListingSummary, dealTabResults, rawComparisonQuoteIds, type View, type SortKey, type TypeFilter, type KindFilter, type SearchPage } from "./search/results";
import { lowestQuotedOffer } from "../../shared/listed-offer";
import { ALL, AUTO_KEY, RECENT_KEY, RECENT_LIMIT, STARTER_SEARCHES, readRecentSearches, readTargets, readAutoSetting, targetText } from "./search/settings";
import { analysisBlockPolicy, describeIntent, describeUsage, type AnalysisBlockCode } from "./search/presentation";
import { automaticListingBlock, describeListingBlock } from "./search/analysis-admission";
import { listingsInDiagnosticBatch, searchDiagnosticRows } from "./search/diagnostic";
import styles from "./App.module.css";

// The views, in order, and what each is called everywhere it appears.
const VIEWS: View[] = ["deals", "all", "bids", "offers", "candidates", "review", "losses"];

// The search shortcut, as this keyboard writes it.
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";

type SearchSummary = Extract<DealsMessage, { type: "start" }>;

export function AnalysisBlockedNotice({ message, code, onRetry }: { message: string; code: AnalysisBlockCode | null; onRetry: () => void }) {
    const effectiveCode = isLegacyAiAccountingFailure(code, message) ? "AI_ACCOUNTING" : code;
    const policy = analysisBlockPolicy(effectiveCode);
    const reason = code === "AI_BUDGET" && message.trim() === "New analysis is stopped. Matching listings can still finish loading; retrying cannot increase this search's AI allowance."
        ? policy.detail : message.trim();
    const repeatsDetail = reason.replace(/\s+/g, " ") === policy.detail.trim().replace(/\s+/g, " ");
    return <div className={styles.searchUpdate} role="alert" data-analysis-block={effectiveCode ?? "AI_PAUSED"}>
        <div><p><strong>{policy.title}</strong></p>{reason && <p>{reason}</p>}{!repeatsDetail && <p>{policy.detail}</p>}</div>
        {policy.retryLabel && <button type="button" className={styles.secondary} onClick={onRetry}>{policy.retryLabel}</button>}
    </div>;
}

export function EnglishOnlyNotice() {
    return <p className={styles.warning} role="status">English cards only. This listing is identified as non-English and is excluded. No additional AI analysis will start for it.</p>;
}

export function App({ initialPage = "search", ebayReturnNotice }: { initialPage?: "search" | "sniper" | "camera"; ebayReturnNotice?: string } = {}) {
    const dockedAnalysis = useMediaQuery("(min-width: 80rem)");
    const [restored] = useState(() => initialPage === "search" ? readContinuationSession() : null);
    const [destination, setDestination] = useState<string | null | undefined>(undefined);
    const destinationReady = destination !== undefined;
    const [destinationError, setDestinationError] = useState(false);
    const [destinationChanged, setDestinationChanged] = useState(false);
    const lastDestination = useRef<string | null | undefined>(undefined);
    const destinationRequest = useRef<AbortController | null>(null);
    const destinationMatches = (quoted: { shippingDestination?: string | null }) =>
        destinationReady && (quoted.shippingDestination ?? null) === destination;
    useEffect(() => {
        if (restored?.newIds) restoreWatchBudget(restored.lastBatchId, restored.request.rootId);
    }, [restored]);
    const [page, setPage] = useState<SearchPage>(initialPage);
    const [flipEntry, setFlipEntry] = useState(() => initialPage === "search" && Boolean(readFlipSession()));
    const showingFlip = flipEntry && page === "search";
    const toolPage = page === "sniper" || page === "camera";
    const [sniperDraft, setSniperDraft] = useState<SniperDraft | null>(null);
    const [listingOwners] = useState(() => new Map<string, string>(restored?.owners));
    const discoveryRunByItem = useRef(listingOwners);
    const directListingRun = useRef<string | undefined>(undefined);
    const [directListing, setDirectListing] = useState<ListingSummary | null>(null);
    const [linkStatus, setLinkStatus] = useState<"idle" | "loading" | "error">("idle");
    const [linkError, setLinkError] = useState("");
    const linkRequest = useRef<AbortController | null>(null);
    const linkRevision = useRef(0);
    const [shortlist, setShortlist] = useState<ShortlistEntry[]>([]);
    const [shortlistLoading, setShortlistLoading] = useState(true);
    const [shortlistError, setShortlistError] = useState("");
    const shortlistRevision = useRef(0);
    const shortlistLoad = useRef(0);
    const [savingIds, setSavingIds] = useState(new Set<string>());
    const activeSaves = useRef(new Set<string>());
    const [refreshingSaved, setRefreshingSaved] = useState(false);
    const refreshingRef = useRef(false);
    const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
    const [saveNotice, setSaveNotice] = useState<{ text: string; error?: boolean } | null>(null);
    const [newMode, setNewMode] = useState(Boolean(restored?.newIds));
    const [newIds, setNewIds] = useState(() => new Set<string>(restored?.newIds ?? []));
    const [newChecked, setNewChecked] = useState(restored?.newIds?.length ?? 0);
    const loadShortlist = useCallback(async () => {
        const revision = shortlistRevision.current;
        const request = ++shortlistLoad.current;
        setShortlistLoading(true);
        try {
            const entries = await fetchShortlist();
            if (request === shortlistLoad.current && revision === shortlistRevision.current) { setShortlist(entries); setShortlistError(""); }
        } catch (error) { if (request === shortlistLoad.current && revision === shortlistRevision.current) setShortlistError((error as Error).message); }
        finally { if (request === shortlistLoad.current) setShortlistLoading(false); }
    }, []);
    useEffect(() => { void loadShortlist(); const refresh = () => void loadShortlist(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [loadShortlist]);
    useEffect(() => { if (!saveNotice || saveNotice.error) return; const timer = window.setTimeout(() => setSaveNotice(null), 5000); return () => window.clearTimeout(timer); }, [saveNotice]);

    const [query, setQuery] = useState(restored?.originalQuery ?? "");
    const [linkEntry, setLinkEntry] = useState(false);
    const searchDraft = useRef(restored?.originalQuery ?? "");
    const linkDraft = useRef("");
    const linkInput = linkEntry || looksLikeListingLink(query);
    const changeQuery = (text: string) => {
        if (!linkInput && looksLikeListingLink(text)) searchDraft.current = query;
        if (linkEntry || looksLikeListingLink(text)) linkDraft.current = text;
        else searchDraft.current = text;
        setQuery(text);
    };
    const [rawListings, setListings] = useState<ListingSummary[]>(restored?.listings ?? []);
    const [standaloneHuntId, setStandaloneHuntId] = useState<string>(() => crypto.randomUUID());
    const [startedHuntScope, setStartedHuntScope] = useState<string | null>(null);
    const [huntBusy, setHuntBusy] = useState(false);
    const [guidedBusy, setGuidedBusy] = useState(false);
    const [huntPrompt, setHuntPrompt] = useState<HuntGoalPrompt | null>(null);
    const [searchPlan, setSearchPlan] = useState<SearchPlan | null>(restored?.plan ?? null);
    const [searchInterpreting, setSearchInterpreting] = useState(false);
    const plannedQuery = useRef(restored?.request.query ?? "");
    const pendingHuntPrompt = useRef<string | null>(null);
    const [panelHunt, setPanelHunt] = useState<{ scope: string; report: DealHuntReport; original: ListingSummary; evaluation: Evaluation; alternative?: DealHuntResponse["alternative"]; gradingValidUntil?: number } | null>(null);
    const now = useNow(30_000, panelHunt?.gradingValidUntil);
    const [auctionUpdates, setAuctionUpdates] = useState(new Map<string, number>());
    useEffect(() => {
        function invalidate(event: Event) {
            const detail = (event as CustomEvent<{ listingId: string; checkedAt: string }>).detail;
            const stamp = Date.parse(detail?.checkedAt);
            if (!detail?.listingId || !Number.isFinite(stamp)) return;
            setAuctionUpdates(previous => (previous.get(detail.listingId) ?? 0) >= stamp ? previous :
                new Map(previous).set(detail.listingId, stamp));
        }
        window.addEventListener("pokemon-auction-terms-changed", invalidate);
        return () => window.removeEventListener("pokemon-auction-terms-changed", invalidate);
    }, []);
    const [pricingBusy, setPricingBusy] = useState(false);
    const [pricingNote, setPricingNote] = useState("");
    const pricingAbort = useRef<AbortController | null>(null);
    const pricingRevision = useRef(0);
    useEffect(() => () => { pricingAbort.current?.abort(); }, []);
    const latestListings = useRef(new Map<string, ListingSummary>());
    latestListings.current = new Map((page === "search" ? [...(directListing ? [directListing] : []), ...shortlist.map((entry) => entry.listing), ...rawListings]
        : page === "listing" ? [...rawListings, ...shortlist.map((entry) => entry.listing), ...(directListing ? [directListing] : [])]
            : [...rawListings, ...(directListing ? [directListing] : []), ...shortlist.map((entry) => entry.listing)]).map((listing) => [listing.id, listing]));
    if (page === "search" && panelHunt?.alternative && !latestListings.current.has(panelHunt.alternative.listing.id)) {
        latestListings.current.set(panelHunt.alternative.listing.id, panelHunt.alternative.listing);
    }
    const [total, setTotal] = useState<number | null>(restored?.listings.length ?? null);
    const [summary, setSummary] = useState<SearchSummary | null>(restored?.summary ?? null);
    if (page === "search" && summary?.comparisonQuote && !latestListings.current.has(summary.comparisonQuote.id)) {
        latestListings.current.set(summary.comparisonQuote.id, summary.comparisonQuote);
    }
    const [discoveryProgress, setDiscoveryProgress] = useState<{ found: number; screened: number } | null>(null);
    const [continuingDiscovery, setContinuingDiscovery] = useState(false);
    const continuationAbort = useRef<AbortController | null>(null);
    const continuationAttempts = useRef(new Set<string>());
    const continuationRequest = useRef<ContinuationRequest | null>(restored?.request ?? null);
    const continuationCheckpoint = useRef<ContinuationSession | null>(restored);
    const [coverage, setCoverage] = useState<ContinuationSession["coverage"]>(restored?.coverage ?? null);

    const lastQuery = useRef(restored?.originalQuery ?? "");
    const bestDealRun = useRef<string | null>(null);
    const watchSearch = useRef(0);
    const [searchStatus, setSearchStatus] = useState<"idle" | "checking" | "done" | "error">(restored?.searchError ? "error" : restored ? "done" : "idle");
    const [completedSearchRunId, setCompletedSearchRunId] = useState<string | null>(restored?.lastBatchId ?? null);
    const [searchError, setSearchError] = useState(restored?.searchError ?? "");
    const [analysisBlocked, setAnalysisBlocked] = useState(restored?.analysisBlocked ?? "");
    const [analysisBlockCode, setAnalysisBlockCode] = useState<AnalysisBlockCode | null>(() =>
        isLegacyAiAccountingFailure(restored?.analysisBlockCode, restored?.analysisBlocked ?? "") ? "AI_ACCOUNTING" : restored?.analysisBlockCode ?? null);
    const analysisPaused = useRef(Boolean(restored?.stopped || restored?.analysisBlocked));
    // Release years by set, loaded once, for the cards' subtitles.
    const [setYearsByKey, setSetYearsByKey] = useState<Record<string, number>>({});

    useEffect(() => {
        fetchSetYears()
            .then(setSetYearsByKey)
            .catch(() => {
                // Without them the cards just show no year.
            });
    }, []);

    const searchId = useRef(0);
    const searchRunId = useRef<string | undefined>(restored?.request.rootId);
    // Stops the running search's stream; the server stops checking with it.
    const searchAbort = useRef<AbortController | null>(null);
    const [stopped, setStopped] = useState(restored?.stopped ?? false);

    const [view, setView] = useState<View>(restored?.newIds ? "new" : "deals");
    const [sort, setSort] = useState<SortKey>("best");
    const [marketplaceOrder, setMarketplaceOrder] = useState<MarketplaceOrder>(restored?.request.order ?? "newest");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>(restored?.filters.typeFilter ?? "FIXED_PRICE");
    const [kindFilter, setKindFilter] = useState<KindFilter>(restored?.filters.kindFilter ?? "all");
    const [maxPrice, setMaxPrice] = useState(restored?.filters.maxPrice === undefined ? "" : String(restored.filters.maxPrice));
    // Buy It Now only: auctions start low on purpose. Remembered between visits.
    const [minPrice, setMinPrice] = useState(() => {
        if (restored) return restored.filters.minPrice ? String(restored.filters.minPrice) : "";
        try {
            return localStorage.getItem("minPrice") ?? "";
        } catch {
            return "";
        }
    });

    function changeMinPrice(text: string) {
        setMinPrice(text);

        try {
            localStorage.setItem("minPrice", text);
        } catch {
            // Without storage the setting lasts for this visit.
        }
    }
    const [submittedFilters, setSubmittedFilters] = useState<ListingFilters | null>(restored?.request.filters ?? null);
    const currentFilters: ListingFilters = useMemo(() => ({ typeFilter, kindFilter, minPrice: Math.max(0, Number(minPrice) || 0), maxPrice: maxPrice === "" ? undefined : Number(maxPrice) }), [typeFilter, kindFilter, minPrice, maxPrice]);
    const analysisSelection = useRef({ page, filters: currentFilters, graded: summary?.intent.graded });
    analysisSelection.current = { page, filters: currentFilters, graded: summary?.intent.graded };
    const filterScopeChanged = submittedFilters !== null && JSON.stringify(currentFilters) !== JSON.stringify(submittedFilters);
    const needsWiderSearch = searchStatus !== "idle" && filterScopeChanged;

    const [autoSetting, setAutoSetting] = useState(readAutoSetting);

    // Today's eBay allowance, checked on load and after each search.
    const [usage, setUsage] = useState<EbayUsage | null>(null);
    const [aiUsage, setAiUsage] = useState<AiUsageDay | null>(null);
    const refreshUsage = useCallback(() => {
        const id = searchRunId.current;
        fetchEbayUsage(id).then(value => { if (searchRunId.current === id) setUsage(value); }, () => {});
        fetchAiUsage(id).then(value => { if (searchRunId.current === id) setAiUsage(value); }, () => {});
    }, []);

    const acceptGuidedUsage = useCallback((value: AiUsageDay) => {
        if (value.searchId === searchRunId.current) setAiUsage(value);
    }, []);
    useEffect(refreshUsage, [refreshUsage]);

    // How many automatic analyses this search may still start.
    const [budget, setBudget] = useState(0);
    const autoQueued = useRef(new Set<string>());

    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Views, targets, filters, and settings, in a drawer from the side.
    const [drawerOpen, setDrawerOpen] = useState(false);

    const [rawAnalyses, setAnalyses] = useState<Record<string, AnalysisState>>(restored?.analyses ?? {});
    useEffect(() => {
        if (guidedBusy) return;
        if (searchStatus !== "checking" && linkStatus !== "loading" && !pricingBusy && !huntBusy && !Object.values(rawAnalyses).some(analysis => analysis.status === "loading")) return;
        let active = true;
        let reading = false;
        // This endpoint reads local accounting only; it never calls providers.
        const timer = window.setInterval(() => {
            if (reading) return;
            reading = true;
            const id = searchRunId.current;
            const hunt = huntBusy ? currentHunt.current.id ?? undefined : undefined;
            fetchAiUsage(id, hunt).then(value => {
                if (active && searchRunId.current === id && (!hunt || currentHunt.current.id === hunt)) setAiUsage(value);
            }, () => {}).finally(() => { reading = false; });
        }, 1500);
        return () => { active = false; window.clearInterval(timer); };
    }, [rawAnalyses, searchStatus, linkStatus, pricingBusy, huntBusy, guidedBusy]);
    const pricingAnalyses = useRef(rawAnalyses);
    pricingAnalyses.current = rawAnalyses;
    const [analysisOutcomes, setAnalysisOutcomes] = useState<boolean[]>([]);
    const [includeOffers, setIncludeOffers] = useState(() => {
        if (restored) return restored.offers;
        try { return localStorage.getItem("includeOffers") !== "0"; } catch { return true; }
    });
    const availableViews: View[] = [...(newMode ? ["new" as const] : []), ...VIEWS.filter((key) => (key !== "offers" || includeOffers) &&
        (key !== "bids" || typeFilter !== "FIXED_PRICE" || view === "bids"))];
    function changeIncludeOffers(enabled: boolean) {
        setIncludeOffers(enabled);
        if (!enabled && view === "offers") setView("deals");
        try { localStorage.setItem("includeOffers", enabled ? "1" : "0"); } catch { /* Visit only. */ }
    }
    const [minGrade, setMinGrade] = useState(() => {
        try { const saved = Number(localStorage.getItem("minGrade")); return Number.isInteger(saved) && saved >= 0 && saved <= 10 ? saved : 0; } catch { return 0; }
    });
    function changeMinGrade(value: number) {
        setMinGrade(value);
        try { localStorage.setItem("minGrade", String(value)); } catch { /* Visit only. */ }
    }

    const [targets, setTargets] = useState<Targets>(() => restored?.targets ?? readTargets());
    const sameSearchText = query.trim() === lastQuery.current.trim();
    const idleHunt = page === "search" && searchStatus === "idle" && !linkInput;
    const promptFormat = huntPrompt?.listingFormat ?? (huntPrompt?.goal === "grade_raw" ? "FIXED_PRICE" : "AUCTION");
    const activeHuntPrompt = idleHunt && sameSearchText && typeFilter === promptFormat && (huntPrompt?.goal !== "grade_raw" || kindFilter !== "graded") ? huntPrompt : null;
    const standaloneHunt = idleHunt && (activeHuntPrompt !== null || (!query.trim() && !huntPrompt));
    const promptProfit = activeHuntPrompt?.minProfit;
    const huntTargets = useMemo(() => promptProfit === undefined ? targets : { ...targets, minProfit: promptProfit }, [targets, promptProfit]);
    const huntFilters = activeHuntPrompt?.maxDelivered !== undefined ? { ...currentFilters,
        maxPrice: Math.min(activeHuntPrompt.maxDelivered, currentFilters.maxPrice ?? Infinity) } : currentFilters;
    const [researchTargets, setResearchTargets] = useState(targets);
    useEffect(() => {
        if (targets.minProfit === researchTargets.minProfit && targets.minRoi === researchTargets.minRoi) return;
        const timer = window.setTimeout(() => setResearchTargets(targets), 500);
        return () => window.clearTimeout(timer);
    }, [targets, researchTargets]);
    const researchTargetsReady = targets.minProfit === researchTargets.minProfit && targets.minRoi === researchTargets.minRoi;
    const [targetInputs, setTargetInputs] = useState(() => targetText(targets));

    // Everything re-priced for your targets, from numbers already fetched.
    const listings = useMemo(
        () =>
            rawListings.map((listing) => {
                const analysis = rawAnalyses[listing.id];
                const evaluation = analysis?.status === "done" && analysis.evidenceKey === listingEvidenceKey(listing) ? analysis.evaluation : undefined;
                const resolved = withResolvedCriteria(listing, evaluation, summary?.intent);
                return resolved.screen ? { ...resolved, screen: retargetScreen(resolved.screen, resolved.currentPrice, targets, undefined, includeOffers, resolved) } : resolved;
            }),
        [rawListings, rawAnalyses, summary, targets, includeOffers]
    );

    const analyses = useMemo(() => {
        const repriced: Record<string, AnalysisState> = {};
        const currentListings = latestListings.current;

        for (const [id, analysis] of Object.entries(rawAnalyses)) {
            const current = currentListings.get(id);
            if (current && analysis.evidenceKey !== listingEvidenceKey(current)) continue;
            const listingTargets = panelHunt?.alternative?.listing.id === id ? huntTargets : targets;
            repriced[id] = displayAnalysis(analysis, listingTargets, now, current);
        }
        for (const entry of shortlist) {
            if (!entry.evaluation || repriced[entry.id]) continue;
            const fresh = currentPriceEvidence(entry.evaluation, now);
            if (!fresh && (page !== "shortlist" || !entry.evaluation.photoCheck)) continue;
            const current = currentListings.get(entry.id) ?? entry.listing;
            const evidenceKey = listingEvidenceKey(current);
            if (evidenceKey !== listingEvidenceKey(entry.listing)) continue;
            repriced[entry.id] = displayAnalysis({ status: "done", evidenceKey, evaluation: entry.evaluation }, targets, now, current, !fresh);
        }
        if (page === "shortlist") for (const entry of shortlist) {
            const analysis = repriced[entry.id];
            if (analysis?.status === "done" && entry.listing.endTime && Date.parse(entry.listing.endTime) <= now) {
                repriced[entry.id] = { ...analysis, evaluation: retargetEvaluation({ ...analysis.evaluation, listing: { ...analysis.evaluation.listing, availability: "UNAVAILABLE" } }, targets) };
            }
        }

        return repriced;
    }, [rawAnalyses, targets, huntTargets, rawListings, shortlist, directListing, page, panelHunt, now]);

    // Language evidence remains useful when saved prices have expired.
    const languageEvaluations = useRef(new Map<string, Evaluation>());
    languageEvaluations.current = new Map(shortlist.filter(entry => entry.evaluation).map(entry => [entry.id, entry.evaluation!]));
    for (const [id, analysis] of Object.entries(analyses)) if (analysis.status === "done") languageEvaluations.current.set(id, analysis.evaluation);
    const shortlistForDisplay = shortlist.map(entry => ({ ...entry, evaluation: languageEvaluations.current.get(entry.id) ?? entry.evaluation }));

    const toggleSaved = async (listing: ListingSummary) => {
        if (activeSaves.current.has(listing.id)) return;
        activeSaves.current.add(listing.id); setSavingIds(new Set(activeSaves.current)); shortlistRevision.current += 1;
        try {
            if (shortlist.some((entry) => entry.id === listing.id)) {
                await removeSavedListing(listing.id); setShortlist((previous) => previous.filter((entry) => entry.id !== listing.id));
                setSaveNotice({ text: "Removed from shortlist." });
            } else {
                const entry = await saveListing(listing); setShortlist((previous) => [entry, ...previous.filter((saved) => saved.id !== entry.id)]);
                setSaveNotice({ text: "Saved to shortlist." });
            }
        } catch (error) { setSaveNotice({ text: (error as Error).message, error: true }); }
        finally { shortlistRevision.current += 1; activeSaves.current.delete(listing.id); setSavingIds(new Set(activeSaves.current)); }
    };
    const removeSaved = async (id: string) => {
        shortlistRevision.current += 1;
        try { await removeSavedListing(id); setShortlist((previous) => previous.filter((entry) => entry.id !== id)); if (selectedId === id) setSelectedId(null); setSaveNotice({ text: "Removed from shortlist." }); }
        finally { shortlistRevision.current += 1; }
    };
    const updateSaved = async (id: string, notes: string, ceiling: number | null) => {
        shortlistRevision.current += 1;
        try { const entry = await updateSavedListing(id, notes, ceiling); setShortlist((previous) => previous.map((saved) => saved.id === id ? { ...saved, notes: entry.notes, ceiling: entry.ceiling } : saved)); }
        finally { shortlistRevision.current += 1; }
    };
    const refreshSaved = async (ids: string[], reviewNewBack = false) => {
        if (refreshingRef.current) return;
        const original = new Map(shortlist.map((entry) => [entry.id, entry]));
        refreshingRef.current = true; setRefreshingSaved(true); shortlistRevision.current += 1;
        try {
            const result = await refreshSavedListings(ids);
            const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
            setShortlist((previous) => previous.flatMap((entry) => {
                const before = original.get(entry.id);
                if (!before || before.savedAt !== entry.savedAt || !ids.includes(entry.id)) return [entry];
                const refreshed = byId.get(entry.id);
                if (!refreshed) return [];
                return [{ ...refreshed,
                    notes: entry.notes === before.notes ? refreshed.notes : entry.notes,
                    ceiling: entry.ceiling === before.ceiling ? refreshed.ceiling : entry.ceiling }];
            }));
            setListings((previous) => previous.map((listing) => ids.includes(listing.id) ? byId.get(listing.id)?.listing ?? listing : listing));
            setDirectListing((previous) => previous && ids.includes(previous.id) ? byId.get(previous.id)?.listing ?? previous : previous);
            setAnalyses((previous) => { const next = { ...previous }; for (const id of ids) { const entry = byId.get(id); if (result.errors.some((error) => error.id === id)) continue;
                if (entry?.evaluation && currentPriceEvidence(entry.evaluation)) next[id] = { status: "done", evidenceKey: listingEvidenceKey(entry.listing), evaluation: entry.evaluation }; else delete next[id]; } return next; });
            setRefreshErrors((previous) => { const next = { ...previous }; for (const id of ids) delete next[id]; for (const error of result.errors) next[error.id] = error.message; return next; });
            const entry = ids.length === 1 ? byId.get(ids[0]) : undefined;
            if (reviewNewBack && !result.errors.length && entry?.needsAnalysis && entry.photoChange?.neededBack &&
                entry.listing.availability !== "UNAVAILABLE" && withinAutomaticAuctionWindow(entry.listing, Date.now()) &&
                englishListingEligible(entry.listing, original.get(entry.id)?.evaluation)) {
                latestListings.current.set(entry.id, entry.listing);
                setSaveNotice({ text: "New seller photos found. Checking whether they resolve the missing back." });
                await runAnalysis(entry.listing, { scope: "shortlist", addedPhotosOnly: true });
            } else setSaveNotice({ text: result.errors.length ? `${result.errors.length} refresh ${result.errors.length === 1 ? "failed" : "checks failed"}. Previous snapshots kept for those listings.` : "Selected listings refreshed. No AI analysis was started.", error: Boolean(result.errors.length) });
            refreshUsage();
        } catch (error) { setSaveNotice({ text: (error as Error).message, error: true }); }
        finally { shortlistRevision.current += 1; refreshingRef.current = false; setRefreshingSaved(false); }
    };

    function changeTarget(field: keyof Targets, text: string) {
        setTargetInputs((previous) => ({ ...previous, [field]: text }));

        // Blank selects Any. A buy still has to produce positive net profit.
        const value = text.trim() === "" ? 0 : Number(text);

        // Half-typed or negative: keep the last good target.
        if (!Number.isFinite(value) || value < 0) return;

        setTargets((previous) => {
            const next = { ...previous, [field]: field === "minRoi" ? value / 100 : value };

            try {
                localStorage.setItem("targets", JSON.stringify(next));
            } catch {
                // Without storage the targets last for this visit.
            }

            return next;
        });
    }

    const activeAnalyses = useRef(new Set<string>());
    const analysisControllers = useRef(new Map<string, AbortController>());
    useEffect(() => () => { for (const controller of analysisControllers.current.values()) controller.abort(); }, []);
    const activePhotoReviews = useRef(new Set<string>());
    const pendingAnalyses = useRef(new Map<string, { listing: ListingSummary; fresh: boolean; automatic: boolean; addedPhotosOnly?: boolean; scope: SearchPage }>());
    const [photoReviews, setPhotoReviews] = useState<Record<string, DeeperReviewState>>({});
    const [priceRefreshes, setPriceRefreshes] = useState<Record<string, PriceRefreshState>>({});

    useEffect(() => {
        if (!filterScopeChanged || searchStatus === "idle") return;
        stopSearch();
    }, [filterScopeChanged, typeFilter, kindFilter, minPrice, maxPrice, searchStatus]);

    useEffect(() => {
        if (page !== "search") return;
        for (const listing of listings) {
            if (!matchesListingFilters(listing, currentFilters, languageEvaluations.current.get(listing.id), summary?.intent.graded)) {
                pendingAnalyses.current.delete(listing.id);
                analysisControllers.current.get(listing.id)?.abort();
            }
        }
    }, [listings, analyses, page, currentFilters, summary]);

    const runAnalysis = useCallback(async (listing: ListingSummary, {
        fresh = false, automatic = false, addedPhotosOnly = false, scope = analysisSelection.current.page, refreshOf,
    }: { fresh?: boolean; automatic?: boolean; addedPhotosOnly?: boolean; scope?: SearchPage; refreshOf?: Extract<AnalysisState, { status: "done" }> } = {}): Promise<void> => {
        const current = latestListings.current.get(listing.id) ?? listing;
        if (!englishListingEligible(current, languageEvaluations.current.get(listing.id))) {
            pendingAnalyses.current.delete(listing.id);
            return;
        }
        if (scope === "search" && !matchesListingFilters(current, analysisSelection.current.filters, languageEvaluations.current.get(listing.id), analysisSelection.current.graded)) {
            pendingAnalyses.current.delete(listing.id);
            return;
        }
        // A direct listing or saved-card analysis gets one capped research run.
        // Retries retain this ID and its already committed spending.
        if (!refreshOf) searchRunId.current ??= crypto.randomUUID();
        const account = refreshOf?.searchRunId ?? searchRunId.current;
        const evidenceKey = listingEvidenceKey(listing);
        if (activeAnalyses.current.has(listing.id) || activePhotoReviews.current.has(listing.id)) {
            if (refreshOf) return;
            pendingAnalyses.current.set(listing.id, { listing, fresh, automatic, addedPhotosOnly, scope });
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now(), evidenceKey } }));
            return;
        }
        activeAnalyses.current.add(listing.id);
        const controller = new AbortController();
        analysisControllers.current.set(listing.id, controller);
        const clearRefresh = () => setPriceRefreshes(previous => {
            if (!previous[listing.id]) return previous;
            const next = { ...previous };
            delete next[listing.id];
            return next;
        });
        if (refreshOf) setPriceRefreshes(previous => ({ ...previous, [listing.id]: { status: "loading", evidenceKey } }));
        else {
            clearRefresh();
            setAnalyses(previous => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now(), evidenceKey } }));
        }
        const stillCurrent = () => {
            const current = latestListings.current.get(listing.id);
            return !current || listingEvidenceKey(current) === evidenceKey;
        };

        try {
            let evaluation = await evaluateListing(listing, { fresh, automatic, addedPhotosOnly, includeOffers, targets, signal: controller.signal,
                typeFilter: scope === "search" ? analysisSelection.current.filters.typeFilter : undefined,
                searchRunId: account, priceOnly: Boolean(refreshOf) });
            controller.signal.throwIfAborted();
            if (stillCurrent()) {
                if (refreshOf && evaluation.listing.availability === "UNAVAILABLE") {
                    const saved = refreshOf.evaluation;
                    evaluation = { ...saved, listing: { ...evaluation.listing, photos: saved.listing.photos,
                        photosInListing: saved.listing.photosInListing, photosAnalyzed: saved.listing.photosAnalyzed },
                        rawPricing: null, gradedPricing: null, slabPricing: null, marketActivity: undefined, underwriting: evaluation.underwriting, rating: null };
                }
                const current = latestListings.current.get(listing.id) ?? listing;
                const updated = withFreshListing(current, evaluation);
                if (updated !== current) {
                    latestListings.current.set(listing.id, updated);
                    setPanelHunt(previous => previous?.alternative?.listing.id === listing.id
                        ? { ...previous, alternative: { ...previous.alternative, listing: updated } } : previous);
                    setDirectListing((previous) => previous?.id === listing.id ? withFreshListing(previous, evaluation) : previous);
                    setListings((previous) => previous.map((item) => item.id === listing.id ? withFreshListing(item, evaluation) : item));
                    setShortlist((previous) => previous.map((entry) => entry.id === listing.id ? { ...entry, listing: withFreshListing(entry.listing, evaluation) } : entry));
                }
                const updatedKey = listingEvidenceKey(updated);
                if (updatedKey === listingEvidenceKey({ title: evaluation.listing.title, images: evaluation.listing.photos ?? updated.images }) || !fresh) {
                    setAnalyses(previous => ({ ...previous, [listing.id]: { status: "done", evaluation, evidenceKey: updatedKey, searchRunId: account } }));
                    if (refreshOf) {
                        const message = evaluation.listing.availability === "UNAVAILABLE" ? "This listing is no longer available. Your photo assessment is still shown."
                            : !evaluation.underwriting?.best || priceEvidenceGap(evaluation) ? "The refresh found no usable resale price."
                            : "Prices updated.";
                        setPriceRefreshes(previous => ({ ...previous, [listing.id]: { status: "done", message, evidenceKey: updatedKey } }));
                    }
                }
            } else if (refreshOf) clearRefresh();
            void loadShortlist();
            if (!refreshOf) setAnalysisOutcomes((previous) => [...previous.slice(-7), true]);
        } catch (error) {
            if (refreshOf) {
                if (controller.signal.aborted || !stillCurrent()) clearRefresh();
                else setPriceRefreshes(previous => ({ ...previous, [listing.id]: { status: "error", evidenceKey,
                    message: error instanceof Error ? error.message : "Prices could not be refreshed." } }));
                return;
            }
            if (controller.signal.aborted) {
                setAnalyses(previous => {
                    if (previous[listing.id]?.status !== "loading") return previous;
                    const next = { ...previous }; delete next[listing.id]; return next;
                });
                return;
            }
            const message = error instanceof Error ? error.message : "Analysis failed";
            if (error instanceof ApiRequestError && error.code === "OTHER_LANGUAGE") {
                pendingAnalyses.current.delete(listing.id);
                if (stillCurrent()) {
                    const excluded = (item: ListingSummary): ListingSummary => item.id === listing.id ? { ...item, match: "OTHER_LANGUAGE" } : item;
                    latestListings.current.set(listing.id, excluded(latestListings.current.get(listing.id) ?? listing));
                    setDirectListing(previous => previous ? excluded(previous) : previous);
                    setListings(previous => previous.map(excluded));
                    setShortlist(previous => previous.map(entry => entry.id === listing.id ? { ...entry, listing: excluded(entry.listing) } : entry));
                    setAnalyses(previous => { const next = { ...previous }; delete next[listing.id]; return next; });
                }
                return;
            }
            if (error instanceof ApiRequestError && error.failureScope !== "listing" && ["AI_CREDITS", "AI_PAUSED", "AI_BUDGET", "AI_ACCOUNTING", "AI_INPUT_PREFLIGHT", "STORAGE_UNAVAILABLE", "PRICE_RESEARCH_BUDGET", "PRICE_RESEARCH_UNAVAILABLE",
                "EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH"].includes(error.code ?? "")) {
                analysisPaused.current = true;
                // Analysis admission must not truncate the independently bounded
                // metadata stream. Storage/provider outages still stop it.
                if (analysisBlockPolicy(error.code as AnalysisBlockCode).stopListingStream) {
                    searchAbort.current?.abort();
                    continuationAbort.current?.abort();
                    searchId.current += 1;
                    setSearchStatus("done");
                }
                pendingAnalyses.current.clear();
                // Budget admission can stop a new candidate while another
                // accepted bounded assessment is finishing. Keep its result.
                if (error.code !== "AI_BUDGET" && error.code !== "PRICE_RESEARCH_BUDGET") for (const other of analysisControllers.current.values()) if (other !== controller) other.abort();
                pricingAbort.current?.abort();
                setAnalysisBlocked(message);
                setAnalysisBlockCode(error.code as AnalysisBlockCode);
                setBudget(0);
                if (stillCurrent()) setAnalyses(previous => { const next = { ...previous }; delete next[listing.id]; return next; });
                return;
            }
            if (error instanceof ApiRequestError && (error.code === "PHOTO_ASSESSMENT_REJECTED" || error.code === "AI_EVIDENCE_HELD")) {
                const status = error.code === "AI_EVIDENCE_HELD" ? "held" : "inconclusive";
                const pending = pendingAnalyses.current.get(listing.id);
                if (pending && listingEvidenceKey(pending.listing) === evidenceKey) pendingAnalyses.current.delete(listing.id);
                if (stillCurrent()) setAnalyses(previous => ({ ...previous, [listing.id]: { status, message, evidenceKey } }));
                return;
            }
            if (stillCurrent()) setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "error", message, evidenceKey } }));
            setAnalysisOutcomes((previous) => [...previous.slice(-7), false]);
        } finally {
            analysisControllers.current.delete(listing.id);
            activeAnalyses.current.delete(listing.id);
            refreshUsage();
            const pending = pendingAnalyses.current.get(listing.id);
            pendingAnalyses.current.delete(listing.id);
            const current = latestListings.current.get(listing.id);
            if (!analysisPaused.current && pending && current && listingEvidenceKey(pending.listing) === listingEvidenceKey(current)) {
                void runAnalysis(current, pending);
            }
        }
    }, [includeOffers, loadShortlist, refreshUsage, targets]);

    const runPhotoReview = useCallback(async (listing: ListingSummary, evaluation: Evaluation) => {
        if (!englishListingEligible(listing, evaluation)) return;
        const key = evaluation.photoReviewKey;
        if (!key || activeAnalyses.current.has(listing.id) || activePhotoReviews.current.has(listing.id)) return;
        activePhotoReviews.current.add(listing.id);
        setPhotoReviews((previous) => ({ ...previous, [listing.id]: { status: "loading", key } }));
        try {
            searchRunId.current ??= crypto.randomUUID();
            const review = await reviewListingPhotos(listing.id, key, searchRunId.current);
            setAnalyses((previous) => {
                const analysis = previous[listing.id];
                if (analysis?.status !== "done" || analysis.evaluation.photoReviewKey !== key) return previous;
                return { ...previous, [listing.id]: { ...analysis, evaluation: { ...analysis.evaluation, deeperPhotoReview: review } } };
            });
            setPhotoReviews((previous) => { const next = { ...previous }; delete next[listing.id]; return next; });
            void loadShortlist();
        } catch (error) {
            setPhotoReviews((previous) => ({ ...previous, [listing.id]: { status: "error", key, message: (error as Error).message } }));
        } finally {
            activePhotoReviews.current.delete(listing.id);
            const pending = pendingAnalyses.current.get(listing.id);
            pendingAnalyses.current.delete(listing.id);
            const current = latestListings.current.get(listing.id);
            if (!analysisPaused.current && pending && current && listingEvidenceKey(pending.listing) === listingEvidenceKey(current)) void runAnalysis(current, pending);
        }
    }, [runAnalysis, loadShortlist]);

    const cancelLink = () => {
        linkRequest.current?.abort(); linkRequest.current = null; linkRevision.current += 1; setLinkStatus("idle");
    };
    const openListingLink = async (input: string) => {
        if (linkRequest.current) return;
        cancelPricing();
        setLinkEntry(true);
        setSelectedId(null); setPage("listing"); setLinkError("");
        const itemId = parseListingLink(input)?.itemId;
        if (!itemId) { setLinkStatus("error"); setLinkError("Paste a full ebay.com/itm/ listing link or its item number."); return; }
        if (activeAnalyses.current.has(itemId) && directListing?.id === itemId) { openPanel(itemId); return; }
        if (searchStatus === "checking" || aiBusy) stopSearch();
        const controller = new AbortController(); linkRequest.current = controller;
        const revision = ++linkRevision.current; setLinkStatus("loading");
        const linkSearchId = crypto.randomUUID();
        searchRunId.current = linkSearchId;
        try {
            const listing = await resolveListingLink(input, controller.signal, linkSearchId);
            if (controller.signal.aborted || linkRevision.current !== revision) return;
            setQuery((previous) => previous.trim() === input.trim() ? listing.url : previous);
            setDirectListing(listing); latestListings.current.set(listing.id, listing);
            directListingRun.current = linkSearchId;
            setListings((previous) => previous.map((item) => item.id === listing.id ? listing : item));
            setLinkStatus("idle");
            // The explicit submit authorizes this one analysis, independent of
            // the search's automatic-analysis budget. No search/discovery starts.
            if (englishListingEligible(listing, languageEvaluations.current.get(listing.id))) {
                openPanel(listing.id);
                void runAnalysis(listing, { scope: "listing" });
            }
        } catch (error) {
            if (!controller.signal.aborted && linkRevision.current === revision) { setLinkStatus("error"); setLinkError((error as Error).message); }
        } finally { if (linkRevision.current === revision) linkRequest.current = null; refreshUsage(); }
    };
    const pendingSubmission = useRef<{ key: string } | null>(null);
    const retryInterpretation = useRef<{ key: string; runId: string } | null>(null);
    const searchKey = (text: string, filters = currentFilters, order = marketplaceOrder) => JSON.stringify([text.trim(), filters, targets, order, includeOffers, autoSetting, destination]);
    const submissionKey = searchKey(query);
    const submittingSameSearch = !linkInput && searchStatus === "checking" && pendingSubmission.current?.key === submissionKey;
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        if (linkInput) { if (!linkWorking) void openListingLink(query); }
        else {
            if (pendingSubmission.current?.key === submissionKey && !searchAbort.current?.signal.aborted) return;
            const submission = { key: submissionKey };
            pendingSubmission.current = submission;
            cancelLink();
            void search(undefined, query).finally(() => {
                if (pendingSubmission.current === submission) pendingSubmission.current = null;
            });
        }
    };
    const chooseEntry = (link: boolean) => {
        setFlipEntry(false);
        cancelLink();
        cancelPricing();
        if (linkInput) linkDraft.current = query; else searchDraft.current = query;
        setLinkEntry(link); setQuery(link ? linkDraft.current : searchDraft.current);
        setSelectedId(null); setPage(link && directListing ? "listing" : "search");
        setLinkError("");
        window.requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
    };

    const [recentSearches, setRecentSearches] = useState<string[]>(readRecentSearches);

    function rememberSearch(text: string) {
        const trimmed = text.trim();

        setRecentSearches((previous) => {
            const next = [trimmed, ...previous.filter((item) => item.toLowerCase() !== trimmed.toLowerCase())].slice(
                0,
                RECENT_LIMIT
            );

            try {
                localStorage.setItem(RECENT_KEY, JSON.stringify(next));
            } catch {
                // Without storage they last for this visit.
            }

            return next;
        });
    }

    function cancelPricing() {
        if (!pricingAbort.current) return;
        pricingAbort.current?.abort(); pricingAbort.current = null; pricingRevision.current += 1;
        setPricingBusy(false); setPricingNote("Pricing retries stopped. Existing results and assessments are kept.");
    }
    async function retryPrices(tickets: string[]) {
        if (pricingAbort.current || !tickets.length) return;
        const controller = new AbortController(); pricingAbort.current = controller;
        const revision = ++pricingRevision.current;
        setPricingBusy(true); setPricingNote("");
        try {
            searchRunId.current ??= crypto.randomUUID();
            const response = await retryPricingBatch(tickets.slice(0, PRICING_RETRY_LIMIT), targets, includeOffers, controller.signal, searchRunId.current);
            if (controller.signal.aborted || pricingRevision.current !== revision) return;
            const results = new Map(response.results.map((result) => [result.id, result]));
            setListings((previous) => previous.map((listing) => {
                const analysis = pricingAnalyses.current[listing.id];
                const result = results.get(listing.id);
                return !result || analysis?.status === "done" || analysis?.status === "loading" ? listing : applyPricingRetry(listing, result);
            }));
            const priced = response.results.filter((result) => result.screen.status !== "UNSCREENED").length;
            setPricingNote(response.note ?? `Pricing updated for ${priced} of ${response.results.length} listings.`);
        } catch (error) { if (!controller.signal.aborted && pricingRevision.current === revision) setPricingNote((error as Error).message); }
        finally { if (pricingRevision.current === revision) { pricingAbort.current = null; setPricingBusy(false); } }
    }

    // From the search box, or a quick pick with its own text.
    async function search(event?: FormEvent, text = query, onlyNew = false, watched?: { id: string; rootId: string; messages: DealsMessage[] }, bestDealFormat?: "AUCTION" | "FIXED_PRICE") {
        event?.preventDefault();

        if (!text.trim()) return;
        setDestinationChanged(false);
        if (!onlyNew) watchSearch.current++;
        analysisPaused.current = true;
        pendingAnalyses.current.clear();
        for (const controller of analysisControllers.current.values()) controller.abort();
        cancelPricing(); setPricingNote("");
        setLinkEntry(false); searchDraft.current = text;
        setPage("search");
        setNewMode(onlyNew); setNewIds(new Set()); setNewChecked(0);


        const id = ++searchId.current;
        const needsPlan = !onlyNew && !watched;
        const searchFilters = bestDealFormat ? { ...huntFilters, typeFilter: bestDealFormat } : currentFilters;
        const order = bestDealFormat === "FIXED_PRICE" ? "lowest" : marketplaceOrder;
        const key = searchKey(text, searchFilters, order);
        const retry = needsPlan && retryInterpretation.current?.key === key ? retryInterpretation.current : null;
        const runId = watched?.id ?? retry?.runId ?? crypto.randomUUID();
        if (needsPlan) retryInterpretation.current = null;
        const rootId = watched?.rootId ?? runId;
        bestDealRun.current = bestDealFormat ? runId : null;
        searchRunId.current = rootId;
        setCompletedSearchRunId(null);
        setAiUsage(null);
        setUsage(previous => previous ? { ...previous, searchBudget: undefined } : previous);
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        setStopped(false);
        if (!onlyNew) {
            lastQuery.current = text;
            rememberSearch(text);
        }

        autoQueued.current = new Set();
        pendingAnalyses.current.clear();
        if (!onlyNew) { setListings([]); discoveryRunByItem.current.clear(); }
        // A new explicit search refreshes stale prices without discarding paid
        // photo work on the server or adding an idle background refresh loop.
        if (!onlyNew) setAnalyses(previous => Object.fromEntries(Object.entries(previous).filter(([itemId, analysis]) =>
            analysis.status === "done" ? currentPriceEvidence(analysis.evaluation) : analysis.status === "loading" && activeAnalyses.current.has(itemId))));
        setTotal(null);
        setSummary(null);
        setDiscoveryProgress(null);
        setContinuingDiscovery(false);
        continuationAbort.current = null;
        continuationAttempts.current.clear();
        continuationRequest.current = null;
        continuationCheckpoint.current = null;
        writeContinuationSession(null);
        setCoverage(null);
        setPriceRefreshes({});
        setSelectedId(null);
        setBudget(autoSetting);
        setView(onlyNew ? "new" : "deals");
        setSearchStatus("checking");
        setSearchError("");
        setAnalysisBlocked("");
        setAnalysisBlockCode(null);
        analysisPaused.current = false;
        setSubmittedFilters(searchFilters);

        setHuntPrompt(null);
        pendingHuntPrompt.current = null;
        setSearchInterpreting(!onlyNew && !watched);
        if (!onlyNew && !watched) { setSearchPlan(null); plannedQuery.current = ""; }

        let awaitingPlan = needsPlan;
        try {
            let effectiveQuery = onlyNew ? plannedQuery.current || text : text;
            let effectiveFilters = searchFilters;
            let effectiveTargets = targets;
            if (!onlyNew && !watched) {
                const plan = await interpretSearchRequest({ query: text, filters: searchFilters }, runId, controller.signal);
                if (searchId.current !== id) return;
                controller.signal.throwIfAborted();
                awaitingPlan = false;
                setSearchPlan(plan);
                setSearchInterpreting(false);
                plannedQuery.current = plan.query;
                effectiveQuery = plan.query;
                const plannedKind = plan.intent.graded === true ? "graded" : plan.intent.graded === false ? "raw" : kindFilter;
                const plannedMax = plan.maxDelivered === null ? searchFilters.maxPrice
                    : Math.min(plan.maxDelivered, searchFilters.maxPrice ?? Infinity);
                const plannedFormat = bestDealFormat ?? (plan.listingFormats?.length === 2 ? "all" : plan.format);
                effectiveFilters = { ...searchFilters, typeFilter: plannedFormat, kindFilter: plannedKind, maxPrice: plannedMax };
                setTypeFilter(plannedFormat);
                setKindFilter(plannedKind);
                setMaxPrice(plannedMax === undefined ? "" : String(plannedMax));
                setSubmittedFilters(effectiveFilters);
                if (plan.minProfit !== null) {
                    effectiveTargets = { ...targets, minProfit: plan.minProfit };
                    setTargets(effectiveTargets);
                    setTargetInputs(targetText(effectiveTargets));
                }
                if (!bestDealFormat && plan.workflow === "market_hunt" && (plan.goal === "grade_raw" || plan.goal === "collect_slab" || plan.minProfit !== null ||
                    /\b(?:flips?|flipping|resell|resale|profit(?:able)?)\b/i.test(text))) {
                    setHuntPrompt({ marketPreferences: plan.marketPreferences, listingFormat: plannedFormat,
                        ...(plan.goal && plan.goal !== "resell" && { goal: plan.goal }),
                        ...(plan.minProfit !== null && { minProfit: plan.minProfit }),
                        ...(plan.maxDelivered !== null && { maxDelivered: plan.maxDelivered }) });
                    pendingHuntPrompt.current = runId;
                    setStandaloneHuntId(runId);
                    if (plan.goal === "grade_raw") setKindFilter("raw");
                    if (plan.goal === "collect_slab") setKindFilter("graded");
                    setSubmittedFilters(null);
                    setSearchStatus("idle");
                    refreshUsage();
                    return;
                }
            }
            continuationRequest.current = { rootId, query: effectiveQuery, filters: effectiveFilters, targets: effectiveTargets,
                offers: includeOffers, automaticPhotos: autoSetting !== 0, order };
            const receive = (message: DealsMessage) => {
                if (searchId.current !== id) return;
                if (message.type === "progress") setDiscoveryProgress({ found: message.found, screened: message.screened });
                if (message.type === "start") {
                    setTotal(message.count);
                    setSummary(message);
                }
                if (message.type === "listing") {
                    discoveryRunByItem.current.set(message.listing.id, runId);
                    setListings((previous) => previous.some((listing) => listing.id === message.listing.id)
                        ? previous.map((listing) => listing.id === message.listing.id ? message.listing : listing) : [...previous, message.listing]);
                    if (onlyNew) { setNewIds((previous) => new Set([...previous, message.listing.id])); setNewChecked((previous) => previous + 1); }
                }
                if (message.type === "done") setCoverage({ ...message, searchTargets: effectiveTargets });
            };
            if (watched) watched.messages.forEach(receive);
            else if (onlyNew) await streamNewDeals(effectiveQuery, { minPrice: effectiveFilters.minPrice ?? 0, signal: controller.signal, targets: effectiveTargets, includeOffers, automaticPhotos: autoSetting !== 0, filters: effectiveFilters, searchRunId: runId, knownIds: rawListings.map((listing) => listing.id) }, receive);
            else await streamDeals(effectiveQuery, { minPrice: effectiveFilters.minPrice ?? 0, signal: controller.signal, targets: effectiveTargets, includeOffers, automaticPhotos: autoSetting !== 0, filters: effectiveFilters, searchRunId: runId, marketplaceOrder: order }, receive);

            if (searchId.current === id) {
                setCompletedSearchRunId(runId);
                setSearchStatus("done");
            }
            refreshUsage();
        } catch (error) {
            refreshUsage();
            if (searchId.current !== id) return;
            if (awaitingPlan && !controller.signal.aborted) retryInterpretation.current = { key, runId };
            cancelSearchWork();
            if (error instanceof ApiRequestError && ["EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH", "AI_CREDITS", "AI_PAUSED", "AI_BUDGET", "AI_ACCOUNTING", "AI_INPUT_PREFLIGHT", "STORAGE_UNAVAILABLE"].includes(error.code ?? "")) {
                const code = error.code as AnalysisBlockCode;
                setAnalysisBlockCode(code); setAnalysisBlocked(error.message);
            }
            setSearchError(error instanceof Error ? error.message : "Search failed");
            setSearchStatus("error");
        } finally { if (searchId.current === id) setSearchInterpreting(false); }
    }

    async function scanGradingWatch(signal: AbortSignal) {
        const rootId = continuationRequest.current?.rootId, query = plannedQuery.current || lastQuery.current;
        if (!completedSearchRunId || !rootId) return 0;
        const id = newWatchScanId(rootId), messages: DealsMessage[] = [];
        const filters: ListingFilters = { ...currentFilters, typeFilter: "FIXED_PRICE", kindFilter: "raw" };
        try {
            await streamNewDeals(query, { searchRunId: id, gradingWatch: true, knownIds: rawListings.map(row => row.id),
                filters, minPrice: filters.minPrice ?? 0, targets, includeOffers, automaticPhotos: true, signal }, message => messages.push(message));
            signal.throwIfAborted();
            const found = messages.filter(message => message.type === "listing").length;
            if (found && rootId === searchRunId.current) await search(undefined, query, true, { id, rootId, messages });
            return found;
        } finally { refreshUsage(); }
    }

    // Already accepted answers can be saved on the server. Cancelling the
    // client requests keeps them from starting later paid stages.
    function cancelSearchWork() {
        setSearchInterpreting(false);
        analysisPaused.current = true;
        pendingAnalyses.current.clear();
        for (const controller of analysisControllers.current.values()) controller.abort();
        searchAbort.current?.abort();
        continuationAbort.current?.abort();
        continuationAbort.current = null;
        setContinuingDiscovery(false);
        setDiscoveryProgress(null);
        searchId.current += 1;
        setBudget(autoQueued.current.size);
    }

    function stopSearch() {
        cancelSearchWork();
        setStopped(true);
        setSearchStatus("done");
    }

    useEffect(() => {
        if (page !== "search" && searchStatus === "checking") stopSearch();
    }, [page, searchStatus]);

    const listingBlock = useCallback((listing: ListingSummary, asOf?: number) => automaticListingBlock(
        listing, currentFilters, languageEvaluations.current.get(listing.id), summary?.intent.graded, newMode ? newIds : null, asOf,
    ), [currentFilters, summary?.intent.graded, newMode, newIds]);

    // Promising candidates go first, up to the shared concurrency ceiling and
    // the user's selected full-analysis setting.
    useEffect(() => {
        if (showingFlip || summary?.reviewSelection || completedSearchRunId || page !== "search" || searchStatus === "error" || analysisPaused.current) return;
        const running = Object.values(analyses).filter((analysis) => analysis.status === "loading").length;
        let remaining = budget - autoQueued.current.size;
        if (remaining <= 0) return;

        const waiting = listings
            .filter((listing) => !listingBlock(listing) && !analyses[listing.id] &&
                !activeAnalyses.current.has(listing.id) && !activePhotoReviews.current.has(listing.id))
            .sort((a, b) => compareAnalysisPriority(a, b, targets));
        let free = Math.min(BOUNDED_AUTO_CONCURRENCY, analysisConcurrency(waiting.length + running, analysisOutcomes)) - running;

        for (const listing of waiting) {
            if (free <= 0 || remaining <= 0) break;

            autoQueued.current.add(listing.id);
            free -= 1;
            remaining -= 1;
            void runAnalysis(listing, { automatic: true });
        }
    }, [showingFlip, listings, analyses, budget, runAnalysis, analysisOutcomes, targets, photoReviews, page, listingBlock, searchStatus, summary?.reviewSelection, completedSearchRunId]);

    function changeAutoSetting(value: number) {
        setAutoSetting(value);
        // Takes effect mid-search too: Off or a lower cap stops new analyses now.
        const cap = value;
        setBudget(cap === ALL ? ALL : Math.max(autoQueued.current.size, cap));

        try {
            localStorage.setItem(AUTO_KEY, String(value));
        } catch {
            // Without storage the setting lasts for this visit.
        }
    }

    const filtered = useMemo(
        () => filterSearchResults({
            listings, analyses, page, intent: summary?.intent, now,
            filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade },
        }),
        [listings, analyses, typeFilter, kindFilter, maxPrice, minPrice, minGrade, now, page, summary]
    );

    const reviewSelection = summary?.reviewSelection;
    const automaticReviews = autoSetting !== 0 && (!!reviewSelection || !!completedSearchRunId);
    const priorityIds = reviewSelection?.listingIds ?? [];
    // Search streams emit the selected IDs before the rest. Keep that priority
    // while finishing every retained listing, including earlier Wait or skip rows.
    const reviewQueue = useMemo(() => {
        const priority = new Map(reviewSelection?.listingIds.map((id, index) => [id, index]));
        return listings.filter(row => discoveryRunByItem.current.has(row.id))
            .sort((a, b) => (priority.get(a.id) ?? Infinity) - (priority.get(b.id) ?? Infinity));
    }, [listings, reviewSelection]);
    // Use the underlying receipt timestamps, before display-only repricing.
    // A manual photo or price refresh must supersede an older buyer decision.
    const reviewEvaluations = new Map<string, Evaluation>();
    for (const row of reviewQueue) {
        const saved = rawAnalyses[row.id];
        if (saved?.status === "done" && saved.evidenceKey === listingEvidenceKey(row)) reviewEvaluations.set(row.id, saved.evaluation);
    }
    for (const entry of shortlist) if (entry.evaluation && !reviewEvaluations.has(entry.id) &&
        reviewQueue.some(row => row.id === entry.id && listingEvidenceKey(row) === listingEvidenceKey(entry.listing))) {
        reviewEvaluations.set(entry.id, entry.evaluation);
    }
    const buyerReviews = useBuyerReviews({
        auctionUpdates,
        searchId: continuationRequest.current?.rootId ?? completedSearchRunId, owners: discoveryRunByItem.current,
        enabled: page === "search" && !showingFlip && automaticReviews && !stopped && !needsWiderSearch && !analysisBlocked,
        ready: lastDestination.current !== undefined && researchTargetsReady && searchStatus === "done" && !pricingBusy, allowResearch: true,
        targets, offers: includeOffers, listings, queue: reviewQueue, evaluations: reviewEvaluations, now,
        busy: new Set([...activeAnalyses.current, ...activePhotoReviews.current]),
        onGlobalHold(code, message) {
            analysisPaused.current = true;
            searchAbort.current?.abort();
            continuationAbort.current?.abort();
            pricingAbort.current?.abort();
            pendingAnalyses.current.clear();
            for (const controller of analysisControllers.current.values()) controller.abort();
            setAnalysisBlockCode(code);
            setAnalysisBlocked(message || analysisBlockPolicy(code).detail);
        },
        onResult(listing, result, owner) {
            const value = result.evaluation;
            const previousEvidence = { listing, evaluation: reviewEvaluations.get(listing.id) };
            if (!value) return previousEvidence;
            if (value.listing.title.trim() !== listing.title.trim() ||
                (value.listing.photos?.length && !searchPhotosFitDetails(listing.images, value.listing.photos))) {
                if (result.decision === "BUY" || result.offer) throw new Error("Listing photos changed");
                return previousEvidence;
            }
            const updated = withFreshListing(listing, value);
            if ((result.decision === "BUY" || result.offer) && (updated.currentPrice !== value.listing.price || updated.shipping !== value.listing.shipping ||
                (updated.shippingDestination ?? null) !== (value.listing.shippingDestination ?? null) ||
                (value.listing.shippingDestination ?? null) !== lastDestination.current ||
                updated.availability !== "ACTIVE")) throw new Error("Listing terms changed");
            if (updated !== listing) {
                setListings(previous => previous.map(row => row.id === listing.id ? withFreshListing(row, value) : row));
            }
            setAnalyses(previous => ({ ...previous, [listing.id]: { status: "done", evaluation: value,
                evidenceKey: listingEvidenceKey(updated), searchRunId: owner } }));
            return { listing: updated, evaluation: value };
        },
    }, restored?.reviews);
    const buyerDecisions = buyerReviews.decisions;
    const checkingIds = automaticReviews && !stopped && !needsWiderSearch ? new Set(reviewQueue.map(row => row.id)) : undefined;
    const decisionForDisplay = (id: string) => buyerDecisions[id] ??
        (analysisBlocked && checkingIds?.has(id) ? { decision: "WAIT" as const, reason: "This copy is waiting for the search to resume." } : undefined);
    const groups = groupSearchResults(filtered, analyses, includeOffers, newIds, buyerDecisions, checkingIds, now);
    const purchasable = filtered.filter(row => buyerDecisions[row.id]?.decision === "BUY" ||
        !buyerDecisions[row.id] && !checkingIds?.has(row.id));
    const alternatives = groups.deals.length ? [] : selectDealAlternatives(purchasable, analyses, targets, now, includeOffers);
    const batchReviewed = automaticReviews && !!completedSearchRunId && reviewQueue.length > 0 && buyerReviews.remaining === 0;
    useEffect(() => { if (batchReviewed) refreshUsage(); }, [batchReviewed, completedSearchRunId, refreshUsage]);

    const saveContinuationCheckpoint = useRef<() => void>(() => {});
    saveContinuationCheckpoint.current = () => {
        const request = continuationRequest.current;
        if (!destinationReady || !completedSearchRunId || !summary || !request) return;
        const owners = [...discoveryRunByItem.current];
        const analyses = Object.fromEntries(Object.entries(rawAnalyses).filter((entry): entry is
            [string, Extract<AnalysisState, { status: "done" }>] =>
            entry[1].status === "done" && discoveryRunByItem.current.has(entry[0])));
        const checkpoint: ContinuationSession = { originalQuery: lastQuery.current, shippingDestination: destination, request, plan: searchPlan,
            filters: currentFilters, targets, offers: includeOffers, lastBatchId: completedSearchRunId,
            owners, listings: rawListings, summary, coverage, analyses, reviews: buyerReviews.readCheckpoint(),
            newIds: newMode ? [...newIds] : null, stopped, searchError, analysisBlocked, analysisBlockCode };
        continuationCheckpoint.current = checkpoint;
        writeContinuationSession(checkpoint);
    };
    useEffect(() => { saveContinuationCheckpoint.current(); }, [destination, summary, completedSearchRunId, stopped, searchError, analysisBlocked, analysisBlockCode]);
    useEffect(() => {
        const save = () => saveContinuationCheckpoint.current();
        window.addEventListener("pagehide", save);
        return () => window.removeEventListener("pagehide", save);
    }, []);

    async function continueDiscovery(next: SearchContinuation, manual = false) {
        const request = continuationRequest.current;
        if (!destinationReady || !request || continuationAbort.current || needsWiderSearch || analysisBlocked || page !== "search") return;
        if (manual) continuationAttempts.current.delete(next.token);
        if (continuationAttempts.current.has(next.token)) return;
        continuationAttempts.current.add(next.token);
        const generation = searchId.current;
        const controller = new AbortController();
        continuationAbort.current = controller;
        searchAbort.current = controller;
        searchRunId.current = request.rootId;
        setContinuingDiscovery(true); setStopped(false); analysisPaused.current = false;
        setSearchStatus("checking"); setSearchError(""); setDiscoveryProgress(null);
        // Advance the cursor only after the response ends successfully. An
        // interrupted response can then replay the same saved batch.
        const batch: { start?: SearchSummary; done?: Extract<DealsMessage, { type: "done" }> } = {};
        const rows = new Map<string, ListingSummary>();
        try {
            await streamDeals(request.query, { minPrice: request.filters.minPrice ?? 0, filters: request.filters,
                targets: request.targets, includeOffers: request.offers, automaticPhotos: request.automaticPhotos,
                marketplaceOrder: request.order, searchRunId: next.searchId, continuation: next.token, signal: controller.signal }, message => {
                if (searchId.current !== generation) return;
                if (message.type === "progress") setDiscoveryProgress({ found: message.found, screened: message.screened });
                if (message.type === "start") batch.start = message;
                if (message.type === "listing") rows.set(message.listing.id, message.listing);
                if (message.type === "done") batch.done = message;
            });
            if (searchId.current !== generation || controller.signal.aborted) return;
            if (!batch.start || !batch.done) throw new Error("This batch ended early. Try continuing the search.");
            if (batch.start.continuation?.blocked) {
                const blocked = batch.start.continuation;
                setSummary(previous => previous ? { ...previous, continuation: blocked } : batch.start!);
            } else {
                const added = [...rows.values()].filter(row => !discoveryRunByItem.current.has(row.id));
                for (const row of added) discoveryRunByItem.current.set(row.id, next.searchId);
                setListings(previous => [...previous, ...added]);
                setTotal(rawListings.length + added.length);
                if (newMode) {
                    setNewIds(previous => new Set([...previous, ...added.map(row => row.id)]));
                    setNewChecked(previous => previous + added.length);
                }
                const latest = batch.start;
                setSummary(previous => {
                    const quotes = [latest.comparisonQuote, previous?.comparisonQuote].filter((row): row is ListingSummary => !!row);
                    return { ...latest, comparisonQuote: lowestQuotedOffer(quotes, Date.now())?.listing };
                });
                setCoverage({ ...batch.done, searchTargets: request.targets });
                if (added.length) setCompletedSearchRunId(next.searchId);
            }
            setSearchStatus("done");
            refreshUsage();
        } catch (error) {
            if (searchId.current !== generation || controller.signal.aborted) return;
            if (error instanceof ApiRequestError && ["EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH", "AI_ACCOUNTING", "AI_INPUT_PREFLIGHT", "AI_BUDGET", "AI_PAUSED", "AI_CREDITS", "STORAGE_UNAVAILABLE"].includes(error.code ?? "")) {
                const code = error.code as AnalysisBlockCode;
                if (code === "STORAGE_UNAVAILABLE") continuationAttempts.current.delete(next.token);
                analysisPaused.current = true;
                setAnalysisBlockCode(code); setAnalysisBlocked(error.message);
                pricingAbort.current?.abort();
            }
            setSearchError(error instanceof Error ? error.message : "The next discovery batch could not finish.");
            setSearchStatus("error");
        } finally {
            if (controller.signal.aborted) continuationAttempts.current.delete(next.token);
            if (continuationAbort.current === controller) {
                continuationAbort.current = null;
                setContinuingDiscovery(false);
            }
        }
    }
    useEffect(() => {
        const next = summary?.continuation;
        if (showingFlip || !destinationReady || !next || next.blocked || autoSetting === 0 || stopped || needsWiderSearch || analysisBlocked || continuingDiscovery ||
            page !== "search" || searchStatus !== "done" || buyerReviews.unreviewed !== 0 || buyerReviews.active !== 0 || huntBusy) return;
        void continueDiscovery(next);
    }, [showingFlip, destinationReady, summary?.continuation, autoSetting, stopped, needsWiderSearch, analysisBlocked, continuingDiscovery,
        page, searchStatus, buyerReviews.unreviewed, buyerReviews.active, huntBusy]);


    const counts = useMemo(() => countSearchResults({ listings, analyses, newMode, newIds, page, intent: summary?.intent,
        filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade } }), [listings, analyses, newMode, newIds, page, summary, typeFilter, kindFilter, maxPrice, minPrice, minGrade]);

    const huntId = standaloneHunt ? standaloneHuntId : !newMode && completedSearchRunId
        ? continuationRequest.current?.rootId ?? completedSearchRunId : completedSearchRunId;
    const huntScope = JSON.stringify([page, huntId, linkInput, typeFilter, kindFilter, minPrice, maxPrice, minGrade, huntTargets, includeOffers]);
    const showingStandaloneHunt = standaloneHunt && (Boolean(activeHuntPrompt) || startedHuntScope === huntScope);
    const selectedHunt = page === "search" && panelHunt?.scope === huntScope && panelHunt.report.destination?.listingId === selectedId ? panelHunt : null;
    const selectedAlternative = selectedHunt?.alternative ? latestListings.current.get(selectedHunt.alternative.listing.id) ?? selectedHunt.alternative.listing : null;
    const expiredHuntGrading = selectedHunt?.gradingValidUntil !== undefined && selectedHunt.gradingValidUntil <= now;
    const outsideSlab = useMemo(() => competitionListingSummary(coverage?.competition, destination), [coverage, destination]);
    if (page === "search" && outsideSlab && !latestListings.current.has(outsideSlab.id)) latestListings.current.set(outsideSlab.id, outsideSlab);
    const comparisonListing = page === "search" && selectedId ? [summary?.comparisonQuote, outsideSlab].find(row => row?.id === selectedId) : null;
    const selectedCandidate = selectedAlternative ?? (page === "shortlist" ? shortlist.map((entry) => entry.listing) : page === "listing" ? directListing ? [directListing] : [] : listings).find((listing) => listing.id === selectedId) ?? comparisonListing;
    const selectedEval = selectedId ? evaluationOf(analyses[selectedId]) : null;
    const selected = selectedCandidate && englishListingEligible(selectedCandidate, languageEvaluations.current.get(selectedCandidate.id)) ? selectedCandidate : null;
    const checkedHuntTime = Date.parse(selectedHunt?.evaluation.listing.termsCheckedAt ?? "");
    const expiredHuntTerms = selectedHunt && selected && selectedHunt.report.decision !== "WAIT" &&
        (!destinationMatches(selectedHunt.evaluation.listing) || !reconcileHuntListing(selectedHunt.original, selectedHunt.evaluation, selected).currentTerms ||
            !(checkedHuntTime <= now && now - checkedHuntTime < BEST_BUY_TERMS_MAX_AGE_MS) || (auctionUpdates.get(selected.id) ?? 0) > checkedHuntTime);
    const directLanguageEligible = !directListing || englishListingEligible(directListing, languageEvaluations.current.get(directListing.id));

    // Filters narrowing the results, shown as a count on the Filters button.
    const activeFilters = [typeFilter !== "all", kindFilter !== "all", maxPrice !== "", minPrice !== "", minGrade > 0, sort !== "best"].filter(
        Boolean
    ).length;
    // The panel slides away before it goes; with reduced motion, it just goes.
    const [panelClosing, setPanelClosing] = useState(false);
    const analysisOpener = useRef<HTMLElement | null>(null);
    const resultAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
    const anchorResults = useCallback(() => {
        const element = analysisOpener.current;
        resultAnchor.current = element?.isConnected ? { element, top: element.getBoundingClientRect().top } : null;
    }, []);
    useLayoutEffect(() => {
        const anchor = resultAnchor.current;
        resultAnchor.current = null;
        if (dockedAnalysis && anchor?.element.isConnected) {
            window.scrollBy(0, anchor.element.getBoundingClientRect().top - anchor.top);
        }
    }, [selectedId, dockedAnalysis]);
    const closeTimer = useRef(0);
    const close = useCallback(() => {
        window.clearTimeout(closeTimer.current);
        anchorResults();
        if (prefersReducedMotion()) {
            setSelectedId(null);
            return;
        }

        setPanelClosing(true);
        closeTimer.current = window.setTimeout(() => {
            setSelectedId(null);
            setPanelClosing(false);
        }, 200);
    }, [anchorResults]);
    const openPanel = (id: string, opener?: HTMLElement) => {
        window.clearTimeout(closeTimer.current);
        setPanelClosing(false);
        analysisOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        anchorResults();
        setPanelHunt(null);
        setSelectedId(id);
    };
    const budgetLeft = budget - autoQueued.current.size;
    const analysisHold = needsWiderSearch ? "Search filters changed. Run a new search to continue."
        : stopped ? "Search stopped"
        : searchStatus === "error" ? "Search failed before assessment finished"
        : analysisBlocked ? analysisBlocked
        : budgetLeft <= 0 ? autoSetting === 0 ? "Automatic assessment is off" : "Automatic assessment count limit reached"
        : null;
    const skipped = new Map<string, { label: string; detail?: string | null }>();
    if (page === "search") for (const listing of listings) {
        if ((newMode && !newIds.has(listing.id)) || buyerDecisions[listing.id] || automaticReviews && !stopped) continue;
        const state = analyses[listing.id];
        if (state?.status === "error" || state?.status === "held") {
            skipped.set(listing.id, { label: state.status === "held" ? "Previous AI check unresolved" : "Assessment failed", detail: state.message });
            continue;
        }
        if (state || activeAnalyses.current.has(listing.id) || activePhotoReviews.current.has(listing.id)) continue;
        const block = listingBlock(listing);
        if (block) skipped.set(listing.id, describeListingBlock(listing, block));
        else if (analysisHold) skipped.set(listing.id, { label: analysisHold });
    }

    const emptyText: Record<View, string> = {
        bids: "No current auction has a checked next bid within its supported resale limit.",
        new: "No unseen listings in this newest-listing window match the current filters. Your earlier results remain in the other views.",
        deals:
            searchStatus === "checking" || counts.analyzing > 0
                ? "No deals yet. Still checking."
                : !automaticReviews && counts.waiting > 0
                  ? `No deals yet. ${counts.waiting} ${counts.waiting === 1 ? "candidate hasn't" : "candidates haven't"} been analyzed: see Under review.`
                  : "No deals in this search at the current prices.",
        candidates: "No cards are waiting to be sorted or assessed.",
        offers: `No offer opportunities within ${MAX_OFFER_DISCOUNT_PERCENT}% of asking. Seller acceptance is unknown.`,
        review: "No listings have a Wait or Skip decision.",
        losses: "No completed assessments show a supported loss at the asking price or current bid.",
        all: "No listings match the filters.",
    };

    const allTab = useRef<HTMLButtonElement>(null);

    // ⌘K (Ctrl+K elsewhere) jumps to search from anywhere.
    const searchInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                if (drawerOpen || sniperDraft || selectedId !== null && !dockedAnalysis) return;
                if (toolPage) setPage("search");
                window.requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
            }
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [drawerOpen, sniperDraft, selectedId, dockedAnalysis, toolPage]);

    // Where the search is, for the progress panel: the free check, then the
    // AI on the best candidates, up to this search's budget.
    const startedAnalyses = listings.filter((listing) => !newMode || newIds.has(listing.id)).map((listing) => analyses[listing.id]).filter(Boolean);
    const aiTarget = Math.max(Math.min(counts.candidates, budget), startedAnalyses.length);
    const aiDone = startedAnalyses.filter((analysis) => analysis.status !== "loading").length;
    const aiBusy = counts.analyzing > 0 || (automaticReviews ? !needsWiderSearch && !analysisBlocked && buyerReviews.remaining > 0 : !analysisPaused.current && counts.waiting > 0 && budgetLeft > 0);
    const scopedListings = newMode ? listings.filter(listing => newIds.has(listing.id)) : listings;
    const waitingForReview = automaticReviews ? buyerReviews.remaining > 0 : !analysisPaused.current && budgetLeft > 0 &&
        scopedListings.some(listing => !analyses[listing.id] && !listingBlock(listing));
    const reviewReady = searchStatus === "done" && !stopped && !waitingForReview && !pricingBusy &&
        scopedListings.every(({ id }) => rawAnalyses[id]?.status !== "loading" &&
            !activeAnalyses.current.has(id) && !activePhotoReviews.current.has(id));
    const huntReady = searchStatus === "done" && !stopped && !analysisBlocked && !pricingBusy &&
        (automaticReviews ? buyerReviews.unreviewed === 0 && buyerReviews.active === 0 : reviewReady);
    const huntListings = huntReady && completedSearchRunId && page === "search" && !needsWiderSearch
        ? filtered.filter(listing => discoveryRunByItem.current.has(listing.id) && (!newMode || newIds.has(listing.id)))
        : [];
    const currentHunt = useRef({ id: huntId, scope: huntScope, listings: huntListings, destination, auctionUpdates });
    currentHunt.current = { id: huntId, scope: huntScope, listings: huntListings, destination, auctionUpdates };
    useEffect(() => { setPanelHunt(null); }, [huntScope]);
    function openHuntEvidence(report: DealHuntReport, original: ListingSummary, evaluation: Evaluation, opener: HTMLElement, scope: DealHuntScope, alternative?: DealHuntResponse["alternative"], showPanel = true, gradingValidUntil?: number) {
        const id = report.destination?.listingId;
        const rootId = standaloneHunt ? huntId : continuationRequest.current?.rootId;
        if (!id || report.searchId !== huntId || currentHunt.current.scope !== huntScope || searchRunId.current !== rootId) return false;
        if (gradingValidUntil !== undefined && gradingValidUntil <= Date.now()) return false;
        const retained = currentHunt.current.listings.find(listing => listing.id === id);
        // Only broaden the original card identity. The selected goal, other buyer filters,
        // and the server's listing-specific evidence still apply to a discovered copy.
        if (alternative && (retained || (!newMode && discoveryRunByItem.current.has(id)) || scope === "search" ||
            scope === "any_card" && !supportsCrossCardHunt(report.goal, evaluation.listing.buyingOption) ||
            scope === "same_set" && summary && evaluatedIdentityMismatch(evaluation, { ...summary.intent, titleWords: [], cardNumber: null }) === "OTHER_SET")) return false;
        const current = retained || alternative ? latestListings.current.get(id) ?? retained ?? alternative?.listing : undefined;
        if (!current || current.id !== id ||
            evaluation.listing.id !== id || !englishListingEligible(current, evaluation) ||
            activeAnalyses.current.has(id) || activePhotoReviews.current.has(id)) return false;
        const { compatible, currentTerms, listing } = reconcileHuntListing(original, evaluation, current);
        if (!compatible) return false;
        const previous = pricingAnalyses.current[id];
        if (previous?.status === "done" && (["answeredAt", "pricesCheckedAt"] as const).some(key =>
            (Date.parse(previous.evaluation[key] ?? "") || 0) > (Date.parse(evaluation[key] ?? "") || 0))) return false;
        const state: AnalysisState = { status: "done", evaluation, evidenceKey: listingEvidenceKey(listing), searchRunId: report.searchId };
        if (report.decision === "BUY" || report.decision === "BID") {
            const now = Date.now();
            const checked = Date.parse(listing.termsCheckedAt ?? "");
            if (!currentTerms || (listing.shippingDestination ?? null) !== currentHunt.current.destination ||
                !(checked <= now && now - checked < BEST_BUY_TERMS_MAX_AGE_MS) ||
                (currentHunt.current.auctionUpdates.get(id) ?? 0) > checked ||
                !filterSearchResults({ listings: [listing], analyses: { [id]: state }, page: "search", intent: alternative ? null : summary?.intent,
                    now, filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade } }).length) return false;
            const currentEvaluation = retargetEvaluation(evaluation, huntTargets, listing);
            if (report.decision === "BID" && currentHuntBid(report.goal, currentEvaluation, huntTargets, now, huntFilters.maxPrice)?.status !== "BID" ||
                report.decision === "BUY" && report.goal !== "collect_slab" && !applyVerifiedPurchase(currentEvaluation, report.verifiedPurchase, huntTargets, now)) return false;
        }
        if (!alternative && listing !== current) setListings(rows => rows.map(row => row.id === id ? listing : row));
        setAnalyses(rows => ({ ...rows, [id]: state }));
        if (showPanel) openPanel(id, opener);
        setPanelHunt({ scope: huntScope, report, original, evaluation, alternative: alternative && { ...alternative, listing }, gradingValidUntil });
        return true;
    }
    function reviewSearch(runId: string, signal: AbortSignal) {
        const waitingReason = needsWiderSearch ? "FILTERS_CHANGED" : analysisBlocked ? analysisBlockCode ?? "ANALYSIS_PAUSED"
            : autoSetting === 0 ? "AUTO_OFF" : budgetLeft <= 0 ? "AUTO_LIMIT" : "NOT_ASSESSED";
        const rows = listingsInDiagnosticBatch(listings, discoveryRunByItem.current, runId);
        return saveSearchDiagnostic(runId, searchDiagnosticRows(rows, analyses, groups, listingBlock, waitingReason, buyerDecisions), signal);
    }
    const phase: SearchPhase =
        searchStatus === "error"
            ? "error"
            : stopped
              ? "stopped"
              : searchStatus === "checking"
                ? summary || discoveryProgress ? "filtering" : "finding"
                : analysisBlocked
                  ? "paused"
                : aiBusy
                  ? "ai"
                  : "done";
    const competitionId = parseListingLink(coverage?.competition?.url)?.itemId;
    const competitionListing = competitionId && listings.find(row => parseListingLink(row.id)?.itemId === competitionId);
    const comparingBuys = !showingFlip && destinationReady && page === "search" && searchStatus === "done" && !stopped && !needsWiderSearch && typeFilter !== "AUCTION";
    const buyingRows = useMemo(() => {
        if (!comparingBuys) return [];
        const quote = summary?.comparisonQuote;
        const extra = quote && !listings.some(row => row.id === quote.id) ? filterSearchResults({
            listings: [quote], analyses, page, intent: summary.intent, now, filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade },
        }) : [];
        return buyingComparisonRows([...filtered, ...extra], analyses, buyerDecisions, destination, minGrade);
    }, [comparingBuys, filtered, listings, analyses, buyerDecisions, destination, minGrade, summary, page, now, typeFilter, kindFilter, maxPrice, minPrice]);
    const competitionPrice = coverage?.competition?.price;
    const comparisonAllowed = kindFilter !== "raw" && competitionPrice !== undefined &&
        competitionPrice >= (Number(minPrice) || 0) && (maxPrice === "" || competitionPrice <= Number(maxPrice)) &&
        (!competitionListing || buyingRows.some(row => row.id === competitionListing.id));
    const deliveredLimit = searchPlan?.maxDelivered ?? undefined;
    // A quote that just arrived can be newer than the last countdown tick.
    const comparisonTime = useMemo(() => Date.now(), [now, buyingRows, coverage]);
    const currentBuys = useMemo(() => comparingBuys
        ? rankCurrentBuys(buyingRows, analyses, summary?.intent, comparisonTime,
            comparisonAllowed && coverage?.searchTargets.minProfit === targets.minProfit && coverage.searchTargets.minRoi === targets.minRoi &&
                (minGrade === 0 || summary?.intent.minGrade != null && summary.intent.minGrade >= minGrade)
                ? coverage.competition : undefined, deliveredLimit)
        : [], [comparingBuys, buyingRows, analyses, summary, comparisonTime, coverage, comparisonAllowed, targets, minGrade, deliveredLimit]);
    const bestCurrentBuy = currentBuys[0];
    const gradedAlternative = bestCurrentBuy && summary?.intent.cardName && kindFilter === "all" && !evaluationOf(analyses[bestCurrentBuy.listingId])?.slab
        ? currentBuys.find(copy => copy.listingId !== bestCurrentBuy.listingId && evaluationOf(analyses[copy.listingId])?.slab)
        : undefined;
    const quotedSearch = useRef<string | null>(null);
    useEffect(() => {
        if (!reviewReady || !completedSearchRunId || phase !== "done" || page !== "search" || needsWiderSearch ||
            quotedSearch.current === completedSearchRunId) return;
        quotedSearch.current = completedSearchRunId;
        const signal = searchAbort.current?.signal;
        const rootId = continuationRequest.current?.rootId;
        const ids = rawComparisonQuoteIds(filtered, analyses, summary?.intent, Date.now());
        if (!signal || signal.aborted || !ids.length) return;
        void (async () => {
            for (const id of ids) {
                if (signal.aborted) return;
                try {
                    const quote = await resolveListingLink(id, signal, completedSearchRunId, true);
                    if (signal.aborted || searchAbort.current?.signal !== signal || searchRunId.current !== rootId) return;
                    setListings(rows => rows.map(row => row.id === quote.id &&
                        listingEvidenceKey(row) === listingEvidenceKey(quote) &&
                        !(Date.parse(row.termsCheckedAt ?? "") > Date.parse(quote.termsCheckedAt ?? ""))
                        ? { ...row, ...quote } : row));
                } catch (error) {
                    if (signal.aborted) break;
                    if (error instanceof ApiRequestError && ["EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH", "EBAY_BUDGET"].includes(error.code ?? "")) {
                        const code = error.code === "EBAY_BUDGET" ? "EBAY_DAILY_BUDGET" : error.code as AnalysisBlockCode;
                        analysisPaused.current = true;
                        setAnalysisBlockCode(code); setAnalysisBlocked(error.message);
                        searchAbort.current?.abort(); continuationAbort.current?.abort(); pricingAbort.current?.abort();
                        break;
                    }
                }
            }
            if (!signal.aborted) refreshUsage();
        })();
    }, [reviewReady, completedSearchRunId, page, phase, needsWiderSearch, filtered, analyses, summary, refreshUsage]);
    const rawComparisons = useMemo(() => comparingBuys
        ? rankRawBuyingComparisons(buyingRows, analyses, summary?.intent, comparisonTime, deliveredLimit) : [],
        [comparingBuys, buyingRows, analyses, summary, comparisonTime, deliveredLimit]);
    const rawComparison = rawComparisons[0];
    const rawComparisonValue = rawComparison && evaluationOf(analyses[rawComparison.listing.id]);
    const dealRows = outsideSlab && currentBuys.some(copy => copy.listingId === outsideSlab.id) && !buyingRows.some(row => row.id === outsideSlab.id)
        ? [...buyingRows, outsideSlab] : buyingRows;
    const lowestQuote = comparingBuys
        ? lowestListedCopy(dealRows, analyses, summary?.intent, comparisonTime, deliveredLimit) : undefined;
    const verifiedDeals = sortSearchResults(groups.deals, analyses, "best", targets, now, buyerDecisions);
    const deals = dealTabResults(verifiedDeals, groups.bids, dealRows, currentBuys, rawComparisons, lowestQuote, targets);
    const dealIds = new Set(deals.listings.map(row => row.id));
    const matchingIds = new Set(groups.all.map(row => row.id));
    const resultGroups = { ...groups, deals: deals.listings, review: groups.review.filter(row => !dealIds.has(row.id)),
        all: [...groups.all, ...deals.listings.filter(row => !matchingIds.has(row.id))] };
    const showDealLabels = view === "deals" || view === "all";
    const visible = view === "deals" && sort === "best" ? deals.listings
        : sortSearchResults(resultGroups[view], analyses, sort, targets, now, buyerDecisions);
    const comparisonOnly = Boolean((lowestQuote || bestCurrentBuy) && !listings.length);
    const bestBuyListing = bestCurrentBuy ? dealRows.find(listing => listing.id === bestCurrentBuy.listingId) : undefined;
    const comparisonExpired = comparingBuys && !bestCurrentBuy && !lowestQuote && !rawComparison &&
        coverage?.competition?.checkedAt && now - Date.parse(coverage.competition.checkedAt) >= BEST_BUY_TERMS_MAX_AGE_MS;

    // Additional work stays within the loaded development batch and is never
    // offered as a way around a server spending pause or a stopped search.
    const showMoreAi = !(completedSearchRunId && autoSetting === 0) && !reviewSelection && !analysisBlocked && !stopped && counts.waiting > 0 && budgetLeft <= 0;
    const progressActions = showMoreAi && (
        <div className={styles.progressActions}>
            <div className={styles.progressButtons}>
                <button type="button" className={styles.secondary} onClick={() => setBudget((current) => current + Math.min(DEVELOPMENT_SEARCH_LIMIT, counts.waiting))}>
                    Analyze remaining within budget
                </button>
            </div>
        </div>
    );

    // One tap down: what eBay returned, and the counts behind the four shown.
    const nextBatch = summary?.continuation;
    const showResume = nextBatch && !continuingDiscovery && !needsWiderSearch && !analysisBlocked &&
        (stopped || nextBatch.blocked || searchStatus === "error");
    const progressDetails = summary && (
        <>
            {newMode ? <p>Loaded a window of {summary.found} newest listings. Skipped {summary.previouslySeen ?? 0} already seen; retained {summary.count} unseen listings.{(summary.deferred ?? 0) > 0 ? ` Another ${summary.deferred} remain in this window for a later scan.` : ""} This scan does not cover all eBay inventory.</p> : <p>
                eBay reports {summary.total.toLocaleString()} results. Loaded {summary.found.toLocaleString()} listings and retained {summary.count.toLocaleString()} after preliminary screening. This limited window does not cover all eBay inventory.
            </p>}
            {summary.soldPurchaseCeiling !== undefined && <p>Searched Buy It Now listings up to {dollars(summary.soldPurchaseCeiling)} before shipping and tax, using recent sales for this exact slab market and your targets.</p>}
            {!newMode && summary.marketplaceOrder && <p>eBay search order was {({ lowest: "lowest price first", newest: "newest first", ending: "ending soonest" })[summary.marketplaceOrder]}.</p>}
            {summary.pricePass?.status === "COMPLETE" && <p>The extra price search found {summary.pricePass.newListings} additional listings and {summary.pricePass.candidates} candidates for assessment.</p>}
            {summary.pricePass?.status === "UNAVAILABLE" && <p>The extra price search was unavailable. Results from the first pass are shown.</p>}
            {summary.screened !== undefined && <p>Checked sold-price evidence for {summary.screened} listings; {summary.priceExcluded ?? 0} were above the supported buying limit and excluded before photo analysis. The app checks retained listings for matching sales and a buying decision.</p>}
            {!!summary.unresolvedOverflow && <p>{summary.unresolvedOverflow} more listings lacked enough evidence for assessment and fell outside the display limit.</p>}
            {((summary.priceExcluded ?? 0) > 0 || summary.soldPurchaseCeiling !== undefined) && <p>Run a new search to find additional listings after changing profit, ROI or offer settings.</p>}
            <p>
                {counts.candidates} listings are eligible for AI analysis; {counts.mismatched} set aside as other cards, sets, languages or search criteria.
            </p>
            <p>Each batch checks up to {DEVELOPMENT_SEARCH_LIMIT} matching listings. Earlier results and accepted assessments stay available as the search continues.</p>
            {nextBatch && <p>
                {nextBatch.pending} listings are waiting to be checked.
                {nextBatch.moreSource ? " More eBay result pages remain." : ""}
                {continuingDiscovery ? " Checking the next batch…" :
                    autoSetting !== 0 && !stopped && !nextBatch.blocked && searchStatus !== "error" ? " The next batch starts after these buyer checks finish." : ""}
                {!continuingDiscovery && !showResume && <button type="button" className={styles.secondary}
                    disabled={needsWiderSearch || !!analysisBlocked || huntBusy || automaticReviews && (buyerReviews.unreviewed > 0 || buyerReviews.active > 0) && !stopped}
                    onClick={() => void continueDiscovery(nextBatch, true)}>Continue remaining listings</button>}
            </p>}
            {summary.sourceLimitReached && <p>eBay's result window ends at 10,000 items for this query. Additional inventory remains outside that source window.</p>}
        </>
    );

    const controlProps = {
        searchPage: page === "search",
        hidden: page !== "search" || searchStatus === "idle",
        idle: searchStatus === "idle",
        views: { view, availableViews, groups: resultGroups, allTab, setView },
        filters: { typeFilter, kindFilter, sort, marketplaceOrder, minPrice, maxPrice, minGrade, setTypeFilter, setKindFilter, setSort, setMarketplaceOrder, changeMinPrice, setMaxPrice, changeMinGrade },
        target: { targets, targetInputs, changeTarget },
        settings: { includeOffers, autoSetting, changeIncludeOffers, changeAutoSetting },
        shipping: {
            busy: searchStatus === "checking" || aiBusy || pricingBusy || huntBusy || guidedBusy || linkStatus === "loading" ||
                activeAnalyses.current.size > 0 || activePhotoReviews.current.size > 0 || refreshingSaved,
            onSaved: (zip: string) => {
                destinationRequest.current?.abort();
                confirmDestination.current(zip);
            },
        },
        drawer: { drawerOpen, setDrawerOpen }, usage, aiUsage,
    };

    function resetSearchDestination() {
        cancelSearchWork();
        cancelLink();
        cancelPricing();
        watchSearch.current++;
        continuationRequest.current = null;
        continuationCheckpoint.current = null;
        continuationAttempts.current.clear();
        writeContinuationSession(null);
        discoveryRunByItem.current.clear();
        searchRunId.current = undefined;
        directListingRun.current = undefined;
        plannedQuery.current = "";
        pendingHuntPrompt.current = null;
        window.clearTimeout(closeTimer.current);
        setListings([]);
        setAnalyses({});
        setPriceRefreshes({});
        setDirectListing(null);
        setSelectedId(null);
        setPanelClosing(false);
        setPanelHunt(null);
        setHuntPrompt(null);
        setStartedHuntScope(null);
        setStandaloneHuntId(crypto.randomUUID());
        setSearchPlan(null);
        setSummary(null);
        setCoverage(null);
        setTotal(null);
        setSubmittedFilters(null);
        setCompletedSearchRunId(null);
        setNewMode(false); setNewIds(new Set()); setNewChecked(0);
        setLinkStatus("idle"); setLinkError("");
        setAnalysisBlocked(""); setAnalysisBlockCode(null);
        setSearchStatus("idle"); setSearchError(""); setStopped(false);
        setLinkEntry(false);
        if (lastQuery.current) setQuery(lastQuery.current);
        else if (linkInput) setQuery(searchDraft.current);
        setView("all"); setPage("search");
    }

    const confirmDestination = useRef<(zip: string | null) => void>(() => {});
    confirmDestination.current = (zip) => {
        const previous = lastDestination.current;
        if (previous !== undefined ? previous !== zip : restored && !matchesContinuationDestination(restored, zip)) {
            resetSearchDestination();
            setDestinationChanged(true);
        }
        lastDestination.current = zip;
        setDestination(zip);
        setDestinationError(false);
        if (zip !== null && previous !== undefined && previous !== zip) window.dispatchEvent(new CustomEvent(SHIPPING_DESTINATION_SAVED, { detail: { zip } }));
    };
    const refreshDestination = useCallback(() => {
        destinationRequest.current?.abort();
        const controller = new AbortController();
        destinationRequest.current = controller;
        setDestination(undefined);
        setDestinationError(false);
        void fetchShippingDestination(controller.signal).then(value => {
            if (controller.signal.aborted) return;
            if (value?.zip !== null && !validShippingZip(value?.zip)) {
                throw new Error("Invalid shipping destination");
            }
            confirmDestination.current(value.zip);
        }).catch(() => {
            if (!controller.signal.aborted) setDestinationError(true);
        }).finally(() => {
            if (destinationRequest.current === controller) destinationRequest.current = null;
        });
    }, []);
    useEffect(() => {
        refreshDestination();
        const visible = () => { if (document.visibilityState === "visible") refreshDestination(); };
        const revised = (event: StorageEvent) => {
            if (event.key === SHIPPING_DESTINATION_REVISION) refreshDestination();
        };
        window.addEventListener("focus", refreshDestination);
        window.addEventListener("storage", revised);
        document.addEventListener("visibilitychange", visible);
        return () => {
            destinationRequest.current?.abort();
            window.removeEventListener("focus", refreshDestination);
            window.removeEventListener("storage", revised);
            document.removeEventListener("visibilitychange", visible);
        };
    }, [refreshDestination]);

    function planAuction(draft: SniperDraft) {
        const sourceRun = page === "search" ? discoveryRunByItem.current.get(draft.itemId) : page === "listing" ? directListingRun.current : undefined;
        const searchId = sourceRun ?? draft.searchId;
        setSniperDraft({ ...draft, searchId });
    }

    function openTool(tool: "sniper" | "camera") {
        cancelLink();
        cancelPricing();
        setSelectedId(null);
        setSniperDraft(null);
        setPage(tool);
    }

    const incomingItemId = parseListingLink(query)?.itemId;
    const linkWorking = linkStatus === "loading" || Boolean(incomingItemId && directListing?.id === incomingItemId && analyses[incomingItemId]?.status === "loading");
    return (
        <div className={styles.shell}>
            <div className={styles.layout} data-split={Boolean(selected && dockedAnalysis) || undefined}>
                <main className={styles.main}>
                    <header className={styles.toolbar}>
                        <div className={styles.brandBar}>
                            <div className={styles.brand}>
                                <img className={styles.logo} src="/pokeball.png" alt="" width={44} height={44} />
                                <div>
                                    <h1 className={styles.title}>
                                        Pokemon Flipper
                                    </h1>
                                    <p className={styles.tagline}>Know the card. Know the price.</p>
                                </div>
                            </div>

                            {/* The menu, top right where everyone expects it: views, targets, filters, settings. */}
                            <button
                                type="button"
                                className={styles.menuButton}
                                aria-haspopup="dialog"
                                aria-label={activeFilters > 0 ? `Filters and settings, ${activeFilters} filters on` : "Filters and settings"}
                                aria-expanded={drawerOpen}
                                onClick={() => setDrawerOpen(true)}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 7h16M4 12h16M4 17h16" />
                                </svg>
                                <span>Settings</span>
                                {activeFilters > 0 && <span className={styles.menuBadge}>{activeFilters}</span>}
                            </button>

                        <nav className={styles.workspaceNav} aria-label="Workspace">
                            <button type="button" aria-label="Search results" aria-pressed={page === "search"} onClick={() => { setFlipEntry(false); cancelLink(); setSelectedId(null); setPage("search"); }}>Results</button>
                            <button type="button" aria-pressed={page === "shortlist"} onClick={() => { cancelLink(); cancelPricing(); setSelectedId(null); setPage("shortlist"); void loadShortlist(); }}>Shortlist ({shortlist.length})</button>
                            <button type="button" aria-pressed={page === "camera"} onClick={() => openTool("camera")}>Grade a card</button>
                            <button type="button" aria-pressed={page === "sniper"} onClick={() => openTool("sniper")}>Sniper</button>
                            {(directListing || linkStatus !== "idle") && <button type="button" aria-pressed={page === "listing"} onClick={() => { setSelectedId(null); setPage("listing"); }}>Listing evaluation</button>}
                            {page === "search" && searchStatus !== "idle" && <button type="button" className={styles.findNew} disabled={searchStatus === "checking" || phase === "ai"} onClick={() => void search(undefined, lastQuery.current, true)}>Find new listings</button>}
                        </nav>
                        </div>
                        {!toolPage && <div className={styles.topRow}>
                            <div className={styles.entryModes} role="group" aria-label="Search mode">
                                <button type="button" aria-pressed={!showingFlip && !linkInput} onClick={() => chooseEntry(false)}>Find a deal</button>
                                <button type="button" aria-pressed={showingFlip} onClick={() => {
                                    stopSearch(); cancelLink(); cancelPricing(); watchSearch.current++;
                                    setFlipEntry(true); setSelectedId(null); setPage("search");
                                }}>Find a flip</button>
                                <button type="button" aria-pressed={!showingFlip && linkInput} onClick={() => chooseEntry(true)}>Evaluate eBay link</button>
                            </div>
                            <div hidden={showingFlip}><form className={styles.searchRow} role="search" onSubmit={submitSearch}>
                                <label className={styles.searchField}>
                                    <SearchIcon className={styles.searchIcon} />
                                    <input
                                        ref={searchInput}
                                        type="search"
                                        required
                                        value={query}
                                        onChange={(event) => changeQuery(event.target.value)}
                                        placeholder={linkInput ? "Paste eBay link" : "Card, set or buying goal"}
                                        aria-label={linkInput ? "eBay listing link" : "Search cards"}
                                        aria-describedby="listing-input-hint"
                                        onDragOver={(event) => { if (event.dataTransfer.types.some((type) => type === "text/uri-list" || type === "text/plain")) event.preventDefault(); }}
                                        onDrop={(event) => {
                                            const input = (event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain")).split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#")) ?? "";
                                            if (looksLikeListingLink(input)) { event.preventDefault(); changeQuery(input.trim()); searchInput.current?.focus(); }
                                        }}
                                        aria-keyshortcuts="Meta+K Control+K"
                                    />
                                    {query && (
                                        <button
                                            type="button"
                                            className={styles.clearSearch}
                                            onClick={() => {
                                                changeQuery("");
                                                searchInput.current?.focus();
                                            }}
                                            aria-label="Clear search"
                                        >
                                            <CloseIcon />
                                        </button>
                                    )}
                                    <kbd className={styles.shortcut} aria-hidden="true">
                                        {SHORTCUT}
                                    </kbd>
                                    {/* Phones: the search button sits inside the field. */}
                                    {!linkInput && <button
                                        type="submit"
                                        className={`${styles.searchSubmit} ${styles.narrowOnly}`}
                                        aria-label="Find deals"
                                        aria-busy={searchStatus === "checking"}
                                        disabled={submittingSameSearch}
                                    >
                                        {searchStatus === "checking" ? <span className={styles.spinner} /> : <ArrowIcon />}
                                    </button>}
                                </label>
                                <button type="submit" className={`${styles.primary} ${linkInput ? styles.linkPrimary : styles.wideOnly}`} aria-label={linkInput ? linkWorking ? "Evaluating…" : "Evaluate listing · paid" : "Find deals"} disabled={submittingSameSearch || (linkInput && linkWorking)}>
                                    {(linkInput ? linkWorking : searchStatus === "checking") ? (
                                        <span className={styles.spinner} aria-hidden="true" />
                                    ) : (
                                        <SearchIcon className={styles.buttonIcon} />
                                    )}
                                    {linkInput ? linkWorking ? "Evaluating…" : "Evaluate listing · paid" : "Find deals"}
                                </button>
                                <p className={styles.inputHint} id="listing-input-hint">{linkInput ? "Paste or drop a link. Uses paid AI." : "Try a card and set, such as Ampharos Aquapolis."}</p>
                            </form></div>
                        </div>}
                        {saveNotice && <p className={saveNotice.error ? styles.warning : styles.saveNotice} role={saveNotice.error ? "alert" : "status"}>{saveNotice.text}</p>}
                        {page === "search" && !showingFlip && (showingStandaloneHunt
                            ? <details className={styles.huntFilters}><summary>Search filters</summary><SearchOptions filters={controlProps.filters} target={controlProps.target} shipping={controlProps.shipping} /></details>
                            : <SearchOptions filters={controlProps.filters} target={controlProps.target} shipping={controlProps.shipping} />)}
                    </header>

                    <AuctionSniper active={page === "sniper"} draft={sniperDraft} onManageAccount={() => openTool("sniper")} returnNotice={ebayReturnNotice}
                        onCloseDraft={() => setSniperDraft(current => current === sniperDraft ? null : current)} />
                    {page !== "sniper" && <ProviderUsageNotice usage={aiUsage?.providers} now={now} />}
                    {!toolPage && analysisBlocked && <AnalysisBlockedNotice message={analysisBlocked} code={analysisBlockCode} onRetry={() => {
                        if (!analysisBlockPolicy(analysisBlockCode).retryLabel) return;
                        // Reuse this search and its existing server allowance.
                        // Completed cards keep their slot; interrupted ones may retry.
                        autoQueued.current = new Set([...autoQueued.current].filter(id => rawAnalyses[id]?.status === "done"));
                        buyerReviews.clearGlobalHolds();
                        analysisPaused.current = false;
                        setAnalysisBlocked(""); setAnalysisBlockCode(null); setBudget(autoSetting);
                        if (page === "listing" && directListing) void runAnalysis(directListing);
                    }} />}
                    {page !== "search" && <SearchControls {...controlProps} />}
                    {!toolPage && !destinationReady && <p className={styles.discoveryNote} role="status">
                        {destinationError ? <>Could not verify the shipping destination. <button type="button" className={styles.secondary} onClick={refreshDestination}>Retry</button></> :
                            "Checking the shipping destination…"}
                    </p>}
                    {!toolPage && destinationChanged && <p className={styles.discoveryNote} role="status">
                        The shipping destination changed. Run the search again for current delivery quotes.
                    </p>}
                    <div hidden={!showingFlip}>
                        <GuidedFlip onUsage={acceptGuidedUsage} active={showingFlip} onBusyChange={setGuidedBusy}
                            onStart={id => { stopSearch(); cancelLink(); cancelPricing(); searchRunId.current = id; setAiUsage(null); }} onDestinationSaved={zip => confirmDestination.current(zip)}
                            filters={currentFilters} targets={targets} minGrade={minGrade} destination={destination} ready={destinationReady}
                            now={now} latest={latestListings.current} updated={auctionUpdates} shortlist={listing => {
                                const saved = shortlist.some(entry => entry.id === listing.id);
                                return <button type="button" aria-pressed={saved} disabled={savingIds.has(listing.id)}
                                    onClick={() => void toggleSaved(listing)}>{saved ? "Saved ✓" : "Shortlist"}</button>;
                            }} />
                    </div>
                    <div hidden={showingFlip || !toolPage && !destinationReady}>
                    {page === "camera" ? <CameraGrade /> : page === "sniper" ? null : page === "shortlist" ? <ShortlistView entries={shortlistForDisplay} loading={shortlistLoading} error={shortlistError} refreshing={refreshingSaved} refreshErrors={refreshErrors}
                        onRetry={() => void loadShortlist()} onRefresh={refreshSaved} onRemove={removeSaved} onUpdate={updateSaved} now={now}
                        renderCard={(entry) => <DealCard listing={entry.listing} analysis={analyses[entry.id]} selected={entry.id === selectedId} now={now} years={setYearsByKey} targets={targets} includeOffers={includeOffers} minGrade={minGrade} photoReviewState={photoReviews[entry.id]}
                            automaticDecision={destinationMatches(entry.evaluation?.listing ?? entry.listing) ? undefined : { decision: "WAIT", reason: PURCHASE_RECHECK_MESSAGE }}
                            onSnipe={planAuction} onOpen={() => openPanel(entry.id)} />} /> : page === "listing" ? <section className={styles.linkEvaluation} aria-labelledby="link-evaluation-heading">
                        <h2 id="link-evaluation-heading">Listing evaluation</h2>
                        {linkStatus === "loading" && <div className={styles.linkLoading} role="status"><p>Reading the listing from eBay…</p><button type="button" className={styles.secondary} onClick={() => { cancelLink(); if (!directListing) setPage("search"); }}>Cancel</button></div>}
                        {linkStatus === "error" && <p role="alert" className={styles.warning}>{linkError}{directListing ? " Your previous listing is still shown below." : ""}</p>}
                        {directListing && linkStatus !== "loading" && !directLanguageEligible && <EnglishOnlyNotice />}
                        {directListing && linkStatus !== "loading" && directLanguageEligible && <div className={styles.directCard}><DealCard listing={directListing} analysis={analyses[directListing.id]} selected={directListing.id === selectedId}
                            now={now} years={setYearsByKey} targets={targets} includeOffers={includeOffers} minGrade={0} photoReviewState={photoReviews[directListing.id]}
                            automaticDecision={destinationMatches(evaluationOf(analyses[directListing.id])?.listing ?? directListing) ? undefined : { decision: "WAIT", reason: PURCHASE_RECHECK_MESSAGE }}
                            saved={shortlist.some((entry) => entry.id === directListing.id)} saving={savingIds.has(directListing.id)} onSave={() => void toggleSaved(directListing)}
                            onSnipe={planAuction} onOpen={() => openPanel(directListing.id)} /></div>}
                        {!directListing && linkStatus === "idle" && <p>Paste an eBay listing link above, then choose Evaluate listing.</p>}
                    </section> : <>
                    {sameSearchText && (searchInterpreting || searchPlan || searchStatus !== "idle" && summary) && <p className={styles.searchMeaning} role="status">
                        {searchInterpreting ? "Understanding your search…" : searchPlan?.summary ?? `Search criteria: ${describeIntent(summary!.intent)}.`}
                    </p>}
                    {searchStatus !== "idle" && !searchInterpreting && (
                        <SearchProgress
                            phase={phase}
                            comparisonOnly={comparisonOnly && !deals.listings.length}
                            discoveryPaused={Boolean(nextBatch?.blocked) && !continuingDiscovery}
                            query={lastQuery.current}
                            error={searchError}
                            ebayTotal={summary?.total ?? null}
                            checked={newMode ? newChecked : listings.length}
                            total={total}
                            discoveryProgress={searchStatus === "checking" ? discoveryProgress ?? undefined : undefined}
                            ai={{ done: aiDone, target: aiTarget, analyzing: counts.analyzing, waiting: counts.waiting, failed: startedAnalyses.filter((analysis) => analysis.status === "error").length, inconclusive: startedAnalyses.filter(analysis => analysis.status === "inconclusive").length, held: startedAnalyses.filter(analysis => analysis.status === "held").length, paused: Boolean(analysisBlocked) || stopped }}
                            stats={{
                                junk: (summary?.skipped ?? 0) + counts.junk,
                                dropped: (summary?.priceExcluded ?? 0) + counts.dropped,
                                unchecked: counts.unchecked,
                                deals: deals.listings.length,
                            }}
                            usage={
                                usage && {
                                    text: `${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} requests left`,
                                    note: describeUsage(usage),
                                    braking: usage.braking,
                                }
                            }
                            onStop={stopSearch}
                            buyerProgress={automaticReviews && completedSearchRunId ? {
                                finished: buyerReviews.reviewed, total: reviewQueue.length, unavailable: buyerReviews.unavailable,
                                priorityTotal: priorityIds.length, priorityDone: priorityIds.filter(id => buyerDecisions[id] && !buyerDecisions[id].unavailable).length,
                                priorityUnavailable: priorityIds.filter(id => buyerDecisions[id]?.unavailable).length,
                                priorityPhotos: priorityIds.filter(id => !!evaluationOf(analyses[id])?.photoCheck).length,
                                active: buyerReviews.active,
                            } : undefined}
                            canStopAssessment={buyerReviews.active > 0 || Array.from(analysisControllers.current.values()).some(({ signal }) => !signal.aborted)}
                            actions={progressActions}
                            details={progressDetails}
                        />
                    )}
                    <SearchControls {...controlProps} />
                    {!automaticReviews && searchStatus !== "idle" && <PricingRetries listings={filtered} reviewCount={groups.review.length} searching={searchStatus === "checking"} analyzed={new Set(Object.entries(analyses).filter(([, analysis]) => analysis.status === "done" || analysis.status === "loading").map(([id]) => id))}
                        busy={pricingBusy} note={pricingNote} onRetry={(tickets) => void retryPrices(tickets)} onCancel={cancelPricing} />}
                    {newMode && <p className={styles.discoveryNote}>Loaded one window of up to 200 newest listings and admitted at most {DEVELOPMENT_SEARCH_LIMIT} unseen candidates for screening. Earlier results stay in All matching; this is a limited development batch.</p>}

                    {needsWiderSearch && <div className={styles.searchUpdate} role="status">
                        <p>Search filters changed. Run the search again to fetch matching listings. Paid work from the previous filter selection has stopped.</p>
                        <button type="button" className={styles.secondary} onClick={() => {
                            setQuery(lastQuery.current);
                            void search(undefined, lastQuery.current);
                        }}>Rerun search</button>
                    </div>}

                    {searchStatus === "idle" && !showingStandaloneHunt && (
                        <EmptyState title={linkInput ? "Check a listing" : "Find the best buy for your card"}
                            text={linkInput ? "Paste its eBay link above for a photo assessment, resale estimates and a price limit." : "Compare matching listings, recent sales and the cost of buying. Try a search to get started."}>
                            {/* One tap to a search: recent ones, or a few to start with. */}
                            {!linkInput && <div className={styles.quickPicks}>
                                <p>{recentSearches.length > 0 ? "Recent searches" : "Try a search"}</p>
                                <div className={styles.quickChips}>
                                    {(recentSearches.length > 0 ? recentSearches : STARTER_SEARCHES).map((text) => (
                                        <button
                                            key={text}
                                            type="button"
                                            className={styles.quickChip}
                                            onClick={() => {
                                                setQuery(text);
                                                void search(undefined, text);
                                            }}
                                        >
                                            {recentSearches.length > 0 ? <ClockIcon /> : <SearchIcon />}
                                            {text}
                                        </button>
                                    ))}
                                </div>
                            </div>}
                            {!linkInput && <div className={styles.resultLegend} aria-label="Result color meanings">
                                <span data-tone="profit"><i aria-hidden="true" />Profit after costs</span>
                                <span data-tone="review"><i aria-hidden="true" />Wait or skip</span>
                                <span><i aria-hidden="true" />Selected listing</span>
                            </div>}
                        </EmptyState>
                    )}

                    {searchStatus !== "idle" &&
                        searchStatus !== "error" &&
                        visible.length === 0 && !comparisonOnly &&
                        !(searchStatus === "checking" && listings.length === 0) &&
                        (view === "deals" && summary ? (
                            <div className={styles.searchUpdate} role="status">
                                <div>
                                    <p><strong>{phase === "done" ? targets.minProfit || targets.minRoi ? "No deals met your resale targets." : "No deals with a current price comparison." : "Checking listings for deals…"}</strong></p>
                                    <p>{phase === "done" ? "See all matches to review the other listings." : "Deals appear here as prices are compared."}</p>
                                    {!automaticReviews && counts.waiting > 0 && <p>{counts.waiting} still await assessment{analysisBlocked ? " while automatic assessments are paused" : " in Under review"}. An unassessed card is not a confirmed deal.</p>}
                                    {!bestCurrentBuy && alternatives.length > 0 && <div className={styles.alternatives}>
                                        <p><strong>Best available options</strong></p>
                                        <ul>{alternatives.map(({ listing, label, profit, roi, offerPrice }) => <li key={listing.id}>
                                            <button type="button" className={`${styles.secondary} ${styles.alternative}`} onClick={() => openPanel(listing.id)}>
                                                <strong>{listing.title}</strong>
                                                <span>{offerPrice === undefined ? label : `Offer ${dollars(offerPrice)} · seller acceptance required`} · {dollars(listing.currentPrice)} {listing.buyingOption === "AUCTION" ? "current bid" : "asking"}</span>
                                                {profit !== null && <span>{dollars(profit)} modeled profit{offerPrice === undefined ? "" : " if accepted"} · {percent(roi)} ROI</span>}
                                            </button>
                                        </li>)}</ul>
                                    </div>}
                                </div>
                                <div className={styles.progressButtons}>
                                    {groups.candidates.length > 0 ? <button type="button" className={styles.secondary} onClick={() => withViewTransition(() => setView("candidates"))}>View listings under review</button> :
                                        groups.review.length > 0 && <button type="button" className={styles.secondary} onClick={() => withViewTransition(() => setView("review"))}>View listings to pass on</button>}
                                    {groups.losses.length > 0 && <button type="button" className={styles.secondary} onClick={() => withViewTransition(() => setView("losses"))}>
                                        View projected losses ({groups.losses.length})
                                    </button>}
                                </div>
                            </div>
                        ) : searchStatus === "checking" && view === "deals" ? (
                            <EmptyState
                                framed
                                title="No deals yet"
                                text="Results will appear here as they're found. The search is still running."
                            />
                        ) : (
                            <p className={styles.status}>{emptyText[view]}</p>
                        ))}

                    {view === "all" && visible.length > 0 && <p className={styles.discoveryNote}>
                        Showing {visible.length} matching {visible.length === 1 ? "listing" : "listings"}.
                    </p>}
                    {view === "losses" && visible.length > 0 && <p className={styles.discoveryNote}>
                        Completed assessments with an estimated net loss at the asking price or current bid.
                    </p>}
                    <div className={styles.results}>
                        {/* Before the first results: placeholders in the shape of cards. */}
                        {searchStatus === "checking" &&
                            listings.length === 0 &&
                            Array.from({ length: 6 }, (_, index) => (
                                <div key={index} className={`${styles.cardSkeleton} shimmer`} aria-hidden="true" />
                            ))}
                        {visible.map((listing, index) => (
                            <DealCard
                                key={listing.id}
                                listing={listing}
                                dealLabel={showDealLabels && dealIds.has(listing.id) ? listing.id === deals.listings[0]?.id ? "Best deal on eBay" : "Deal" : undefined}
                                dealComparison={showDealLabels ? deals.reasons.get(listing.id) : undefined}
                                index={index}
                                // The first screenfuls glide when you sort or filter.
                                transitionName={index < 24 ? transitionName(listing.id) : undefined}
                                analysis={analyses[listing.id]}
                                automaticDecision={decisionForDisplay(listing.id)}
                                reviewPending={automaticReviews && !stopped && !needsWiderSearch && !buyerDecisions[listing.id]}
                                reviewActive={buyerReviews.activeIds.has(listing.id)}
                                assessmentNote={analyses[listing.id]?.status === "held" ? undefined : skipped.get(listing.id)?.label}
                                photoReviewState={photoReviews[listing.id]}
                                saved={shortlist.some((entry) => entry.id === listing.id)}
                                saving={savingIds.has(listing.id)}
                                onSave={() => void toggleSaved(listing)}
                                onSnipe={planAuction}
                                years={setYearsByKey}
                                minGrade={minGrade}
                                targets={targets}
                                includeOffers={includeOffers}
                                selected={listing.id === selectedId}
                                now={now}
                                onOpen={() => openPanel(listing.id)}
                            />
                        ))}
                    </div>
                    {bestCurrentBuy && (view !== "deals" || !bestBuyListing && !deals.listings.length) && <BestCurrentBuy reference={bestCurrentBuy} evaluation={evaluationOf(analyses[bestCurrentBuy.listingId])}
                        onOpen={bestBuyListing ? () => openPanel(bestBuyListing.id) : undefined} />}
                    {view !== "deals" && lowestQuote && !bestCurrentBuy && !rawComparison && <LowestListedCopy {...lowestQuote} now={now} onOpen={filtered.some(row => row.id === lowestQuote.listing.id)
                        ? () => openPanel(lowestQuote.listing.id) : undefined} />}
                    {showResume && <div className={styles.searchUpdate}>
                        <p role="status">{nextBatch.blocked ? "The eBay allowance paused further discovery." :
                            "More listings are available to check."}</p>
                        <button type="button" className={`${styles.secondary} ${styles.resumeDiscovery}`}
                            onClick={() => void continueDiscovery(nextBatch, true)}>Continue remaining listings</button>
                    </div>}
                    {page === "search" && searchStatus !== "idle" && searchStatus !== "error" && !stopped && !analysisBlocked &&
                        !needsWiderSearch && autoSetting !== 0 && typeFilter !== "AUCTION" && kindFilter !== "graded" && !summary?.intent.graded &&
                        <GradingWatch key={JSON.stringify([watchSearch.current, currentFilters, targets, includeOffers, minGrade])}
                            listings={filtered} decisions={buyerDecisions} now={now}
                            canScan={reviewReady && selectedId === null && !drawerOpen && !sniperDraft}
                            onScan={scanGradingWatch} onOpen={openPanel} onRecheck={buyerReviews.recheckQuote} />}
                    {huntId && (standaloneHunt && activeHuntPrompt || sameSearchText && huntReady && (huntListings.length > 0 || huntBusy) && page === "search" && !needsWiderSearch) &&
                        <DealHunt active={!showingFlip && page === "search"} key={huntScope} searchId={huntId} standalone={standaloneHunt} now={now} updatedTerms={auctionUpdates} filters={huntFilters} usage={aiUsage}
                            latestListings={latestListings.current} destinationReady={destinationReady}
                            initialGoal={completedSearchRunId && completedSearchRunId === bestDealRun.current ? "best_ebay" : activeHuntPrompt?.goal} marketPreferences={activeHuntPrompt?.marketPreferences}
                            onBestEbaySearch={format => {
                                const text = query.trim() || "Pokémon cards";
                                setQuery(text);
                                if (format === "FIXED_PRICE") setMarketplaceOrder("lowest");
                                void search(undefined, text, false, undefined, format);
                            }}
                            onFormatChange={format => { setHuntPrompt(null); setTypeFilter(format); }}
                            takePrompt={() => { if (pendingHuntPrompt.current !== huntId) return false; pendingHuntPrompt.current = null; return true; }} minPotentialGrade={minGrade}
                            listings={huntListings} listingOwners={discoveryRunByItem.current} targets={huntTargets} onOpen={openHuntEvidence} onBusyChange={setHuntBusy}
                            shortlistButton={listing => {
                                const saved = shortlist.some(entry => entry.id === listing.id);
                                const saving = savingIds.has(listing.id);
                                return <button type="button" aria-pressed={saved} disabled={saving} onClick={() => void toggleSaved(listing)}>
                                    {saving ? "Saving…" : saved ? "Saved ✓" : "Shortlist"}
                                </button>;
                            }}
                            onStart={() => { if (standaloneHunt) { searchRunId.current = standaloneHuntId; setStartedHuntScope(huntScope); } }}
                            onClear={() => { if (selectedAlternative) setSelectedId(null); setPanelHunt(null); }} onUsage={refreshUsage} />}
                    {page === "search" && completedSearchRunId && !stopped && !needsWiderSearch && summary?.intent.grader && typeFilter !== "AUCTION" &&
                        <CollectorStrategy key={completedSearchRunId} searchId={completedSearchRunId} />}
                    {page === "search" && !needsWiderSearch && typeFilter !== "FIXED_PRICE" && <>
                        <AuctionOpportunities listings={filtered} decisions={buyerDecisions} now={now} onOpen={openPanel}
                            bestValueFirst={Boolean(completedSearchRunId && completedSearchRunId === bestDealRun.current)} />
                        <AuctionTracking />
                    </>}
                    {page === "search" && searchStatus === "done" && !stopped && !needsWiderSearch && typeFilter !== "FIXED_PRICE" &&
                        <CompetingAuctions listings={filtered} analyses={analyses} intent={summary?.intent} targets={targets} now={now} onOpen={openPanel} />}
                    {page === "search" && searchStatus === "done" && !stopped && !needsWiderSearch && typeFilter !== "AUCTION" &&
                        <ResaleReceiptMatches listings={purchasable} analyses={analyses} intent={summary?.intent} now={now} onOpen={openPanel} />}
                    {view !== "deals" && gradedAlternative && <button type="button" className={styles.alternative} onClick={() => openPanel(gradedAlternative.listingId)}>
                        <strong>Graded alternative · {gradedAlternative.title}</strong>
                        <span>{dollars(gradedAlternative.pricing.totalCost)} delivered · {gradedAlternative.basis} · {gradedAlternative.pricing.sales} matched sales</span>
                    </button>}
                    {page === "search" && <CollectorFinds listings={filtered} analyses={analyses} intent={summary?.intent} now={now}
                        searchRunId={completedSearchRunId} searchQuery={lastQuery.current}
                        ready={searchStatus === "done" && !stopped && !needsWiderSearch && typeFilter !== "AUCTION"}
                        onOpen={openPanel} onSearch={text => { setQuery(text); void search(undefined, text); }} />}
                    {view !== "deals" && rawComparison && rawComparisonValue && rawComparison.listing.id !== bestCurrentBuy?.listingId &&
                        <RawCopyComparison comparison={rawComparison} evaluation={rawComparisonValue} onOpen={openPanel} />}
                    {comparisonExpired ? <p className={styles.discoveryNote}>The buying comparison’s price and shipping check has expired. Run the search again to refresh it.</p> :
                        !bestCurrentBuy && !lowestQuote && !rawComparison && page === "search" && phase === "done" && !needsWiderSearch && coverage && typeFilter !== "AUCTION" &&
                        <p className={styles.discoveryNote}>The checked listings did not provide a current match with enough evidence to compare prices.</p>}
                    </>}
                    </div>
                    {!showingFlip && !toolPage && (searchStatus !== "idle" || page !== "search") && <details className={styles.searchDiagnostics}>
                        <summary>Search details &amp; usage<span>Coverage, skipped listings and research costs</span></summary>
                        <div className={styles.diagnosticsBody}>
                    <AiBudgetStatus budget={aiUsage?.budget} calls={aiUsage?.calls ?? 0} />
                    <PriceResearchStatus usage={aiUsage?.pricing} />
                    {completedSearchRunId && !stopped && <div hidden={page !== "search"}>
                        <SearchReview key={completedSearchRunId} ready={page === "search" && reviewReady}
                            onReview={(signal) => reviewSearch(completedSearchRunId, signal)} />
                    </div>}
                    {searchStatus !== "idle" && <SearchCoverage report={coverage} finished={searchStatus === "done" || searchStatus === "error"} />}
                    {skipped.size > 0 && <details className={styles.skippedListings}>
                        <summary>Why listings weren’t assessed ({skipped.size})</summary>
                        <p>Reasons for listings retained by this search. See Listing coverage for listings outside the results.</p>
                        <ul>{listings.map(listing => {
                            const reason = skipped.get(listing.id);
                            return reason && <li key={listing.id}><strong>{listing.title}</strong><span>{reason.label}{reason.detail ? ` · ${reason.detail}` : ""}</span></li>;
                        })}</ul>
                    </details>}
                        </div>
                    </details>}
                </main>

                {selected && destinationReady && (
                    <DetailPanel
                        docked={dockedAnalysis}
                        automaticDecision={expiredHuntTerms || !destinationMatches(selectedEval?.listing ?? selected) ? { decision: "WAIT", reason: PURCHASE_RECHECK_MESSAGE } :
                            expiredHuntGrading ? { decision: "WAIT", reason: expiredGradingReason } : page === "search" && !selectedAlternative ? decisionForDisplay(selected.id) : undefined}
                        reviewPending={page === "search" && !selectedAlternative && !!checkingIds?.has(selected.id) && !buyerDecisions[selected.id]}
                        reviewActive={buyerReviews.activeIds.has(selected.id)}
                        huntFocus={!expiredHuntGrading && !expiredHuntTerms && !needsWiderSearch && selectedHunt &&
                            (selectedHunt.report.decision !== "BID" || selectedEval && currentHuntBid(selectedHunt.report.goal, selectedEval, huntTargets, now, huntFilters.maxPrice)?.status === "BID")
                            ? selectedHunt : null}
                        returnFocus={analysisOpener}
                        listing={selected}
                        closing={panelClosing}
                        minGrade={page === "listing" ? 0 : minGrade}
                        targets={selectedAlternative ? huntTargets : targets}
                        includeOffers={includeOffers}
                        analysis={analyses[selected.id]}
                        now={now}
                        onClose={close}
                        onSnipe={planAuction}
                        onAnalyze={(fresh) => runAnalysis(selected, { fresh })}
                        onRefreshPrices={() => {
                            const refreshOf = analyses[selected.id];
                            if (refreshOf?.status === "done") void runAnalysis(selected, { refreshOf });
                        }}
                        priceRefresh={priceRefreshes[selected.id]?.evidenceKey === listingEvidenceKey(selected) ? priceRefreshes[selected.id] : undefined}
                        saved={shortlist.some((entry) => entry.id === selected.id)}
                        saving={savingIds.has(selected.id)}
                        onSave={() => void toggleSaved(selected)}
                        photoReviewState={photoReviews[selected.id]}
                        onPhotoReview={() => {
                            const analysis = analyses[selected.id];
                            if (analysis?.status === "done") void runPhotoReview(selected, analysis.evaluation);
                        }}
                    />
                )}
            </div>
        </div>
    );
}
