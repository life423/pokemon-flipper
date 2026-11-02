import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { prefersReducedMotion, transitionName, withViewTransition } from "./motion";
import type { EbayUsage, Evaluation, ListingSummary, Targets } from "./types";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import type { AiUsageDay } from "../../shared/ai-usage.ts";
import { fetchAiUsage, ApiRequestError } from "./api";
import { analysisConcurrency, canAutoAnalyze } from "../../shared/analysis.ts";
import { matchesListingFilters } from "../../shared/listing-filters.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { looksLikeListingLink, parseListingLink } from "../../shared/listing-link.ts";
import { withResolvedCriteria } from "../../shared/search-criteria.ts";
import { applyPricingRetry, PRICING_RETRY_LIMIT, type PricingRecoveryProgress } from "../../shared/pricing-retries.ts";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";
import { evaluateListing, fetchEbayUsage, fetchSetYears, reviewListingPhotos, streamDeals, streamNewDeals, fetchShortlist, saveListing, removeSavedListing, updateSavedListing, refreshSavedListings, resolveListingLink, retryPricingBatch, type DealsMessage } from "./api";
import type { ShortlistEntry } from "../../shared/shortlist.ts";
import { ShortlistView } from "./components/ShortlistView";
import { AiBudgetStatus } from "./components/AiBudgetStatus";
import type { DeeperReviewState } from "./components/PhotoReview";
import { DealCard } from "./components/DealCard";
import { PricingRetries } from "./components/PricingRetries";
import { EmptyState } from "./components/EmptyState";
import { SearchProgress, type SearchPhase } from "./components/SearchProgress";
import {
    ArrowIcon,
    ClockIcon,
    CloseIcon,
    SearchIcon,
} from "./components/Icons";
import { DetailPanel } from "./components/DetailPanel";
import { useNow } from "./useNow";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { SearchControls } from "./search/SearchControls";
import type { AnalysisState } from "./analysis-state";
import { filterSearchResults, groupSearchResults, sortSearchResults, countSearchResults, evaluationOf, type View, type SortKey, type TypeFilter, type KindFilter } from "./search/results";
import { ALL, AUTO_KEY, RECENT_KEY, RECENT_LIMIT, STARTER_SEARCHES, readRecentSearches, readTargets, readAutoSetting, readResultsSetting, targetText } from "./search/settings";
import { analysisBlockPolicy, describeIntent, describeUsage, type AnalysisBlockCode } from "./search/presentation";
import styles from "./App.module.css";

export type { AnalysisState } from "./analysis-state";

// The views, in order, and what each is called everywhere it appears.
const VIEWS: View[] = ["all", "deals", "offers", "candidates", "review"];

// The search shortcut, as this keyboard writes it.
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";

type SearchSummary = Extract<DealsMessage, { type: "start" }>;

export function AnalysisBlockedNotice({ message, code, onRetry }: { message: string; code: AnalysisBlockCode | null; onRetry: () => void }) {
    const policy = analysisBlockPolicy(code);
    return <div className={styles.searchUpdate} role="alert" data-analysis-block={code ?? "AI_PAUSED"}>
        <div><p><strong>{policy.title}</strong></p><p>{message}</p><p>{policy.detail}</p></div>
        {policy.retryLabel && <button type="button" className={styles.secondary} onClick={onRetry}>{policy.retryLabel}</button>}
    </div>;
}

export function EnglishOnlyNotice() {
    return <p className={styles.warning} role="status">English cards only. This listing is identified as non-English and is excluded. No additional AI analysis will start for it.</p>;
}

export function App() {
    const now = useNow(30_000);
    const [page, setPage] = useState<"search" | "shortlist" | "listing">("search");
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
    const [newMode, setNewMode] = useState(false);
    const [newIds, setNewIds] = useState(new Set<string>());
    const [newChecked, setNewChecked] = useState(0);
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

    const [query, setQuery] = useState("");
    const [linkEntry, setLinkEntry] = useState(false);
    const searchDraft = useRef("");
    const linkDraft = useRef("");
    const linkInput = linkEntry || looksLikeListingLink(query);
    const changeQuery = (text: string) => {
        if (!linkInput && looksLikeListingLink(text)) searchDraft.current = query;
        if (linkEntry || looksLikeListingLink(text)) linkDraft.current = text;
        else searchDraft.current = text;
        setQuery(text);
    };
    const [rawListings, setListings] = useState<ListingSummary[]>([]);
    const [pricingBusy, setPricingBusy] = useState(false);
    const [pricingNote, setPricingNote] = useState("");
    const [pricingRecovery, setPricingRecovery] = useState<PricingRecoveryProgress | null>(null);
    const pricingAbort = useRef<AbortController | null>(null);
    const pricingRevision = useRef(0);
    useEffect(() => () => { pricingAbort.current?.abort(); }, []);
    const latestListings = useRef(new Map<string, ListingSummary>());
    latestListings.current = new Map((page === "search" ? [...(directListing ? [directListing] : []), ...shortlist.map((entry) => entry.listing), ...rawListings]
        : page === "listing" ? [...rawListings, ...shortlist.map((entry) => entry.listing), ...(directListing ? [directListing] : [])]
            : [...rawListings, ...(directListing ? [directListing] : []), ...shortlist.map((entry) => entry.listing)]).map((listing) => [listing.id, listing]));
    const [total, setTotal] = useState<number | null>(null);
    const [summary, setSummary] = useState<SearchSummary | null>(null);

    // Dig deeper: the listings the plain search missed.
    const [digStatus, setDigStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
    const [digTotal, setDigTotal] = useState(0);
    const [digChecked, setDigChecked] = useState(0);
    const [digError, setDigError] = useState<string | null>(null);
    const lastQuery = useRef("");
    const [searchStatus, setSearchStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
    const [searchError, setSearchError] = useState("");
    const [analysisBlocked, setAnalysisBlocked] = useState("");
    const [analysisBlockCode, setAnalysisBlockCode] = useState<AnalysisBlockCode | null>(null);
    const analysisPaused = useRef(false);
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
    const searchRunId = useRef<string | undefined>(undefined);
    // Stops the running search's stream; the server stops checking with it.
    const searchAbort = useRef<AbortController | null>(null);
    const [stopped, setStopped] = useState(false);

    const [view, setView] = useState<View>("all");
    const [sort, setSort] = useState<SortKey>("best");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("FIXED_PRICE");
    const [kindFilter, setKindFilter] = useState<KindFilter>("all");
    const [maxPrice, setMaxPrice] = useState("");
    // Buy It Now only: auctions start low on purpose. Remembered between visits.
    const [minPrice, setMinPrice] = useState(() => {
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
    const [submittedFilters, setSubmittedFilters] = useState<ListingFilters | null>(null);
    const currentFilters: ListingFilters = { typeFilter, kindFilter, minPrice: Math.max(0, Number(minPrice) || 0), maxPrice: maxPrice === "" ? undefined : Number(maxPrice) };
    const filterScopeChanged = submittedFilters !== null && JSON.stringify(currentFilters) !== JSON.stringify(submittedFilters);
    const needsWiderSearch = searchStatus !== "idle" && filterScopeChanged;

    const [autoSetting, setAutoSetting] = useState(readAutoSetting);
    const [resultsSetting, setResultsSetting] = useState(readResultsSetting);

    // Today's eBay allowance, checked on load and after each search.
    const [usage, setUsage] = useState<EbayUsage | null>(null);
    const [aiUsage, setAiUsage] = useState<AiUsageDay | null>(null);
    const refreshUsage = useCallback(() => {
        fetchEbayUsage().then(setUsage, () => {});
        const id = searchRunId.current;
        fetchAiUsage(id).then(value => { if (searchRunId.current === id) setAiUsage(value); }, () => {});
    }, []);

    useEffect(refreshUsage, [refreshUsage]);

    function changeResultsSetting(value: number) {
        setResultsSetting(value);

        try {
            localStorage.setItem("results", String(value));
        } catch {
            // Without storage the setting lasts for this visit.
        }
    }
    // How many automatic analyses this search may still start.
    const [budget, setBudget] = useState(0);
    const autoQueued = useRef(new Set<string>());

    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Views, targets, filters, and settings, in a drawer from the side.
    const [drawerOpen, setDrawerOpen] = useState(false);

    const [rawAnalyses, setAnalyses] = useState<Record<string, AnalysisState>>({});
    useEffect(() => {
        if (!Object.values(rawAnalyses).some(analysis => analysis.status === "loading")) return;
        let active = true;
        // This endpoint reads local accounting only; it never calls providers.
        const timer = window.setInterval(() => {
            const id = searchRunId.current;
            fetchAiUsage(id).then(value => { if (active && searchRunId.current === id) setAiUsage(value); }, () => {});
        }, 1500);
        return () => { active = false; window.clearInterval(timer); };
    }, [rawAnalyses]);
    const pricingAnalyses = useRef(rawAnalyses);
    pricingAnalyses.current = rawAnalyses;
    const [analysisOutcomes, setAnalysisOutcomes] = useState<boolean[]>([]);
    const [includeOffers, setIncludeOffers] = useState(() => {
        try { return localStorage.getItem("includeOffers") === "1"; } catch { return false; }
    });
    const availableViews: View[] = [...(newMode ? ["new" as const] : []), ...VIEWS.filter((key) => key !== "offers" || includeOffers)];
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

    const [targets, setTargets] = useState<Targets>(readTargets);
    const [targetInputs, setTargetInputs] = useState(() => targetText(readTargets()));

    // Everything re-priced for your targets, from numbers already fetched.
    const listings = useMemo(
        () =>
            rawListings.map((listing) => {
                const analysis = rawAnalyses[listing.id];
                const evaluation = analysis?.status === "done" && analysis.evidenceKey === listingEvidenceKey(listing) ? analysis.evaluation : undefined;
                const resolved = withResolvedCriteria(listing, evaluation, summary?.intent);
                return resolved.screen ? { ...resolved, screen: retargetScreen(resolved.screen, resolved.currentPrice, targets, undefined, includeOffers) } : resolved;
            }),
        [rawListings, rawAnalyses, summary, targets, includeOffers]
    );

    const analyses = useMemo(() => {
        const repriced: Record<string, AnalysisState> = {};
        const currentListings = latestListings.current;

        for (const [id, analysis] of Object.entries(rawAnalyses)) {
            const current = currentListings.get(id);
            if (current && analysis.evidenceKey !== listingEvidenceKey(current)) continue;
            repriced[id] =
                analysis.status === "done"
                    ? { ...analysis, evaluation: retargetEvaluation(analysis.evaluation, targets, current) }
                    : analysis;
        }
        for (const entry of shortlist) {
            if (!entry.evaluation || !currentPriceEvidence(entry.evaluation, now) || repriced[entry.id]) continue;
            const current = currentListings.get(entry.id) ?? entry.listing;
            if (listingEvidenceKey(current) !== listingEvidenceKey(entry.listing)) continue;
            repriced[entry.id] = { status: "done", evidenceKey: listingEvidenceKey(current), evaluation: retargetEvaluation(entry.evaluation, targets, current) };
        }
        if (page === "shortlist") for (const entry of shortlist) {
            const analysis = repriced[entry.id];
            if (analysis?.status === "done" && entry.listing.endTime && Date.parse(entry.listing.endTime) <= now) {
                repriced[entry.id] = { ...analysis, evaluation: retargetEvaluation({ ...analysis.evaluation, listing: { ...analysis.evaluation.listing, availability: "UNAVAILABLE" } }, targets) };
            }
        }

        return repriced;
    }, [rawAnalyses, targets, rawListings, shortlist, directListing, page, now]);

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
    const refreshSaved = async (ids: string[]) => {
        if (refreshingRef.current) return;
        refreshingRef.current = true; setRefreshingSaved(true); shortlistRevision.current += 1;
        try {
            const result = await refreshSavedListings(ids);
            const byId = new Map(result.entries.map((entry) => [entry.id, entry]));
            setShortlist((previous) => previous.flatMap((entry) => ids.includes(entry.id) ? byId.has(entry.id) ? [byId.get(entry.id)!] : [] : [entry]));
            setListings((previous) => previous.map((listing) => ids.includes(listing.id) ? byId.get(listing.id)?.listing ?? listing : listing));
            setDirectListing((previous) => previous && ids.includes(previous.id) ? byId.get(previous.id)?.listing ?? previous : previous);
            setAnalyses((previous) => { const next = { ...previous }; for (const id of ids) { const entry = byId.get(id); if (result.errors.some((error) => error.id === id)) continue;
                if (entry?.evaluation && currentPriceEvidence(entry.evaluation)) next[id] = { status: "done", evidenceKey: listingEvidenceKey(entry.listing), evaluation: entry.evaluation }; else delete next[id]; } return next; });
            setRefreshErrors((previous) => { const next = { ...previous }; for (const id of ids) delete next[id]; for (const error of result.errors) next[error.id] = error.message; return next; });
            setSaveNotice({ text: result.errors.length ? `${result.errors.length} refresh ${result.errors.length === 1 ? "failed" : "checks failed"}. Previous snapshots kept for those listings.` : "Selected listings refreshed. No AI analysis was started.", error: Boolean(result.errors.length) });
            refreshUsage();
        } catch (error) { setSaveNotice({ text: (error as Error).message, error: true }); }
        finally { shortlistRevision.current += 1; refreshingRef.current = false; setRefreshingSaved(false); }
    };

    function changeTarget(field: keyof Targets, text: string) {
        setTargetInputs((previous) => ({ ...previous, [field]: text }));

        // Empty means any: no minimum. The max bid still stops at break-even.
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
    const pendingAnalyses = useRef(new Map<string, { listing: ListingSummary; fresh: boolean; automatic: boolean }>());
    const [photoReviews, setPhotoReviews] = useState<Record<string, DeeperReviewState>>({});

    useEffect(() => {
        if (!filterScopeChanged || searchStatus === "idle") return;
        analysisPaused.current = true;
        searchAbort.current?.abort();
        searchId.current += 1;
        pendingAnalyses.current.clear();
        for (const controller of analysisControllers.current.values()) controller.abort();
        setStopped(true);
        setSearchStatus("done");
        setBudget(autoQueued.current.size);
        setDigStatus(previous => previous === "checking" ? "idle" : previous);
    }, [filterScopeChanged, typeFilter, kindFilter, minPrice, maxPrice, searchStatus]);

    useEffect(() => {
        if (page !== "search") return;
        for (const listing of listings) {
            if (!matchesListingFilters(listing, { typeFilter, kindFilter, maxPrice: maxPrice === "" ? undefined : Number(maxPrice), minPrice: Number(minPrice) || 0 })) {
                pendingAnalyses.current.delete(listing.id);
                analysisControllers.current.get(listing.id)?.abort();
            }
        }
    }, [listings, page, typeFilter, kindFilter, maxPrice, minPrice]);

    const runAnalysis = useCallback(async (listing: ListingSummary, fresh = false, automatic = false): Promise<void> => {
        const current = latestListings.current.get(listing.id) ?? listing;
        if (!englishListingEligible(current, languageEvaluations.current.get(listing.id))) {
            pendingAnalyses.current.delete(listing.id);
            return;
        }
        // A direct listing or saved-card analysis gets one capped research run.
        // Retries retain this ID and its already committed spending.
        searchRunId.current ??= crypto.randomUUID();
        const evidenceKey = listingEvidenceKey(listing);
        if (activeAnalyses.current.has(listing.id) || activePhotoReviews.current.has(listing.id)) {
            pendingAnalyses.current.set(listing.id, { listing, fresh, automatic });
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now(), evidenceKey } }));
            return;
        }
        activeAnalyses.current.add(listing.id);
        const controller = new AbortController();
        analysisControllers.current.set(listing.id, controller);
        setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now(), evidenceKey } }));
        const stillCurrent = () => {
            const current = latestListings.current.get(listing.id);
            return !current || listingEvidenceKey(current) === evidenceKey;
        };

        try {
            const evaluation = await evaluateListing(listing, { fresh, automatic, signal: controller.signal, searchRunId: searchRunId.current });
            controller.signal.throwIfAborted();
            if (stillCurrent()) {
                const current = latestListings.current.get(listing.id) ?? listing;
                const updated = withFreshListing(current, evaluation);
                if (updated !== current) {
                    latestListings.current.set(listing.id, updated);
                    setDirectListing((previous) => previous?.id === listing.id ? withFreshListing(previous, evaluation) : previous);
                    setListings((previous) => previous.map((item) => item.id === listing.id ? withFreshListing(item, evaluation) : item));
                    setShortlist((previous) => previous.map((entry) => entry.id === listing.id ? { ...entry, listing: withFreshListing(entry.listing, evaluation) } : entry));
                }
                if (listingEvidenceKey(updated) === listingEvidenceKey({ title: evaluation.listing.title, images: evaluation.listing.photos ?? updated.images }) || !fresh) {
                    setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "done", evaluation, evidenceKey: listingEvidenceKey(updated) } }));
                }
            }
            void loadShortlist();
            setAnalysisOutcomes((previous) => [...previous.slice(-7), true]);
        } catch (error) {
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
            if (error instanceof ApiRequestError && ["AI_CREDITS", "AI_PAUSED", "AI_BUDGET", "STORAGE_UNAVAILABLE"].includes(error.code ?? "")) {
                analysisPaused.current = true;
                searchAbort.current?.abort();
                searchId.current += 1;
                pendingAnalyses.current.clear();
                // Budget admission can stop a new candidate while another
                // accepted bounded assessment is finishing. Keep its result.
                if (error.code !== "AI_BUDGET") for (const other of analysisControllers.current.values()) if (other !== controller) other.abort();
                pricingAbort.current?.abort();
                setSearchStatus("done");
                setAnalysisBlocked(message);
                setAnalysisBlockCode(error.code as AnalysisBlockCode);
                setDigStatus(previous => previous === "checking" ? "idle" : previous);
                setBudget(0);
                if (stillCurrent()) setAnalyses(previous => { const next = { ...previous }; delete next[listing.id]; return next; });
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
                void runAnalysis(current, pending.fresh, pending.automatic);
            }
        }
    }, [loadShortlist, refreshUsage]);

    const runPhotoReview = useCallback(async (listing: ListingSummary, evaluation: Evaluation) => {
        if (!englishListingEligible(listing, evaluation)) return;
        const key = evaluation.photoReviewKey;
        if (!key || activeAnalyses.current.has(listing.id) || activePhotoReviews.current.has(listing.id)) return;
        activePhotoReviews.current.add(listing.id);
        setPhotoReviews((previous) => ({ ...previous, [listing.id]: { status: "loading", key } }));
        try {
            const review = await reviewListingPhotos(listing.id, key);
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
            if (!analysisPaused.current && pending && current && listingEvidenceKey(pending.listing) === listingEvidenceKey(current)) void runAnalysis(current, pending.fresh, pending.automatic);
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
        if (!parseListingLink(input)) { setLinkStatus("error"); setLinkError("Paste a full ebay.com/itm/ listing link or its item number."); return; }
        const itemId = parseListingLink(input)!.itemId;
        if (activeAnalyses.current.has(itemId) && directListing?.id === itemId) { openPanel(itemId); return; }
        if (searchStatus === "checking") stopSearch();
        const controller = new AbortController(); linkRequest.current = controller;
        const revision = ++linkRevision.current; setLinkStatus("loading");
        try {
            const listing = await resolveListingLink(input, controller.signal);
            if (controller.signal.aborted || linkRevision.current !== revision) return;
            setQuery((previous) => previous.trim() === input.trim() ? listing.url : previous);
            setDirectListing(listing); latestListings.current.set(listing.id, listing);
            setListings((previous) => previous.map((item) => item.id === listing.id ? listing : item));
            setLinkStatus("idle");
            // The explicit submit authorizes this one analysis, independent of
            // the search's automatic-analysis budget. No search/discovery starts.
            if (englishListingEligible(listing, languageEvaluations.current.get(listing.id))) {
                openPanel(listing.id);
                searchRunId.current = crypto.randomUUID();
                void runAnalysis(listing);
            }
        } catch (error) {
            if (!controller.signal.aborted && linkRevision.current === revision) { setLinkStatus("error"); setLinkError((error as Error).message); }
        } finally { if (linkRevision.current === revision) linkRequest.current = null; refreshUsage(); }
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        if (linkInput) { if (!linkWorking) void openListingLink(query); }
        else { cancelLink(); void search(undefined, query); }
    };
    const chooseEntry = (link: boolean) => {
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
            const response = await retryPricingBatch(tickets.slice(0, PRICING_RETRY_LIMIT), targets, includeOffers, controller.signal);
            if (controller.signal.aborted || pricingRevision.current !== revision) return;
            const results = new Map(response.results.map((result) => [result.id, result]));
            setListings((previous) => previous.map((listing) => {
                const analysis = pricingAnalyses.current[listing.id];
                const result = results.get(listing.id);
                return !result || analysis?.status === "done" || analysis?.status === "loading" ? listing : applyPricingRetry(listing, result);
            }));
            const priced = response.results.filter((result) => result.screen.status !== "UNSCREENED").length;
            setPricingNote(response.note ?? `Pricing updated for ${priced} of ${response.results.length} listings. Existing assessments were kept.`);
        } catch (error) { if (!controller.signal.aborted && pricingRevision.current === revision) setPricingNote((error as Error).message); }
        finally { if (pricingRevision.current === revision) { pricingAbort.current = null; setPricingBusy(false); } }
    }

    // From the search box, or a quick pick with its own text.
    async function search(event?: FormEvent, text = query, onlyNew = false) {
        event?.preventDefault();

        if (!text.trim()) return;
        analysisPaused.current = true;
        pendingAnalyses.current.clear();
        for (const controller of analysisControllers.current.values()) controller.abort();
        cancelPricing(); setPricingNote(""); setPricingRecovery(null);
        setLinkEntry(false); searchDraft.current = text;
        setPage("search");
        setNewMode(onlyNew); setNewIds(new Set()); setNewChecked(0);


        const id = ++searchId.current;
        searchRunId.current = crypto.randomUUID();
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        setStopped(false);
        lastQuery.current = text;
        rememberSearch(text);
        setDigStatus("idle");
        setDigTotal(0);
        setDigChecked(0);
        setDigError(null);

        autoQueued.current = new Set();
        pendingAnalyses.current.clear();
        if (!onlyNew) setListings([]);
        // A new explicit search refreshes stale prices without discarding paid
        // photo work on the server or adding an idle background refresh loop.
        if (!onlyNew) setAnalyses(previous => Object.fromEntries(Object.entries(previous).filter(([itemId, analysis]) =>
            analysis.status === "done" ? currentPriceEvidence(analysis.evaluation) : analysis.status === "loading" && activeAnalyses.current.has(itemId))));
        setTotal(null);
        setSummary(null);
        setSelectedId(null);
        setBudget(autoSetting);
        setView(onlyNew ? "new" : "all");
        setSearchStatus("checking");
        setSearchError("");
        setAnalysisBlocked("");
        setAnalysisBlockCode(null);
        analysisPaused.current = false;
        setSubmittedFilters(currentFilters);

        try {
            const receive = (message: DealsMessage) => {
                if (searchId.current !== id) return;
                if (message.type === "start") {
                    setTotal(message.count);
                    setSummary(message);
                }
                if (message.type === "listing") {
                    setListings((previous) => previous.some((listing) => listing.id === message.listing.id)
                        ? previous.map((listing) => listing.id === message.listing.id ? message.listing : listing) : [...previous, message.listing]);
                    if (onlyNew) { setNewIds((previous) => new Set([...previous, message.listing.id])); setNewChecked((previous) => previous + 1); }
                }
                if (message.type === "discovery") {
                    setDigStatus(message.status);
                    setDigTotal(message.total);
                    setDigChecked(message.checked);
                    setDigError(message.note ?? null);
                }
                if (message.type === "pricing") setPricingRecovery(message);
                if (message.type === "pricing-listing" && message.listing.screen) {
                    const result = { id: message.listing.id, snapshotKey: message.snapshotKey, screen: message.listing.screen, match: message.listing.match };
                    setListings((previous) => previous.map((listing) => {
                        const analysis = pricingAnalyses.current[listing.id];
                        return listing.id !== result.id || analysis?.status === "done" || analysis?.status === "loading" ? listing : applyPricingRetry(listing, result);
                    }));
                }
            };
            const filters = { typeFilter, kindFilter, maxPrice: maxPrice === "" ? undefined : Number(maxPrice) };
            if (onlyNew) await streamNewDeals(text, { minPrice: Math.max(0, Number(minPrice) || 0), signal: controller.signal, targets, includeOffers, filters, searchRunId: searchRunId.current, knownIds: rawListings.map((listing) => listing.id) }, receive);
            else await streamDeals(text, { maxResults: resultsSetting, minPrice: Number(minPrice) || 0, signal: controller.signal, targets, includeOffers, filters, searchRunId: searchRunId.current }, receive);

            if (searchId.current === id) setSearchStatus("done");
            refreshUsage();
        } catch (error) {
            refreshUsage();
            if (searchId.current !== id) return;
            setSearchError(error instanceof Error ? error.message : "Search failed");
            setSearchStatus("error");
        }
    }

    // Stop detaches running evaluations too. Already accepted paid answers
    // can be saved on the server, but later stages must not be started.
    function stopSearch() {
        analysisPaused.current = true;
        pendingAnalyses.current.clear();
        for (const controller of analysisControllers.current.values()) controller.abort();
        searchAbort.current?.abort();
        searchId.current += 1;
        setBudget(autoQueued.current.size);
        setStopped(true);
        setSearchStatus("done");
        if (digStatus === "checking") {
            setDigStatus("error");
            setDigError("Automatic discovery stopped. Results checked so far stay below.");
        }
    }

    // Promising candidates go first, up to the shared concurrency ceiling and
    // the user's selected full-analysis setting.
    useEffect(() => {
        if (page !== "search" || analysisPaused.current) return;
        const running = Object.values(analyses).filter((analysis) => analysis.status === "loading").length;
        let remaining = budget - autoQueued.current.size;
        if (remaining <= 0) return;

        const waiting = listings
            .filter(listing => englishListingEligible(listing, languageEvaluations.current.get(listing.id)))
            .filter(listing => matchesListingFilters(listing, { typeFilter, kindFilter, maxPrice: maxPrice === "" ? undefined : Number(maxPrice), minPrice: Number(minPrice) || 0 }))
            // Resolve metadata and unusual prices as they arrive too. Auction
            // likelihood affects presentation and priority, not permission to
            // inspect the actual card within the user's analysis budget.
            .filter((listing) => (!newMode || newIds.has(listing.id)) && canAutoAnalyze(listing) && !analyses[listing.id] &&
                !activeAnalyses.current.has(listing.id) && !activePhotoReviews.current.has(listing.id))
            .sort((a, b) => compareAnalysisPriority(a, b, targets));
        let free = analysisConcurrency(waiting.length + running, analysisOutcomes) - running;

        for (const listing of waiting) {
            if (free <= 0 || remaining <= 0) break;

            autoQueued.current.add(listing.id);
            free -= 1;
            remaining -= 1;
            void runAnalysis(listing, false, true);
        }
    }, [listings, analyses, budget, runAnalysis, analysisOutcomes, targets, photoReviews, page, newMode, newIds, typeFilter, kindFilter, maxPrice, minPrice]);

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

    const groups = useMemo(() => groupSearchResults(filtered, analyses, includeOffers, newIds), [filtered, analyses, includeOffers, newIds]);

    const visible = useMemo(() => sortSearchResults(groups[view], analyses, sort, targets, now), [groups, view, sort, analyses, targets, now]);

    const counts = useMemo(() => countSearchResults({ listings, analyses, newMode, newIds, page, intent: summary?.intent,
        filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade } }), [listings, analyses, newMode, newIds, page, summary, typeFilter, kindFilter, maxPrice, minPrice, minGrade]);

    const selectedCandidate = (page === "shortlist" ? shortlist.map((entry) => entry.listing) : page === "listing" ? directListing ? [directListing] : [] : listings).find((listing) => listing.id === selectedId) ?? null;
    const selected = selectedCandidate && englishListingEligible(selectedCandidate, languageEvaluations.current.get(selectedCandidate.id)) ? selectedCandidate : null;
    const directLanguageEligible = !directListing || englishListingEligible(directListing, languageEvaluations.current.get(directListing.id));

    // Filters narrowing the results, shown as a count on the Filters button.
    const activeFilters = [typeFilter !== "all", kindFilter !== "all", maxPrice !== "", minPrice !== "", minGrade > 0, sort !== "best"].filter(
        Boolean
    ).length;
    // The panel slides away before it goes; with reduced motion, it just goes.
    const [panelClosing, setPanelClosing] = useState(false);
    const closeTimer = useRef(0);
    const close = useCallback(() => {
        if (prefersReducedMotion()) {
            setSelectedId(null);
            return;
        }

        setPanelClosing(true);
        closeTimer.current = window.setTimeout(() => {
            setSelectedId(null);
            setPanelClosing(false);
        }, 200);
    }, []);
    const openPanel = (id: string) => {
        window.clearTimeout(closeTimer.current);
        setPanelClosing(false);
        setSelectedId(id);
    };
    const budgetLeft = budget - autoQueued.current.size;

    const emptyText: Record<View, string> = {
        new: "No unseen listings in this newest-listing window match the current filters. Your earlier results remain in the other views.",
        deals:
            searchStatus === "checking" || counts.analyzing > 0
                ? "No deals yet. Still checking."
                : counts.waiting > 0
                  ? `No deals yet. ${counts.waiting} ${counts.waiting === 1 ? "candidate hasn't" : "candidates haven't"} been analyzed: see Sorting.`
                  : "No deals in this search at the current prices.",
        candidates: "No cards are waiting to be sorted or assessed.",
        offers: "No offer opportunities within 10% of asking. Seller acceptance is never assumed.",
        review: "Nothing needs review.",
        hidden: "No hidden opportunities found. Every search automatically checks for overlooked listings.",
        all: "No listings match the filters.",
    };

    const allTab = useRef<HTMLButtonElement>(null);

    // ⌘K (Ctrl+K elsewhere) jumps to search from anywhere.
    const searchInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                if (drawerOpen || selectedId !== null) return;
                searchInput.current?.focus();
                searchInput.current?.select();
            }
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [drawerOpen, selectedId]);

    // Where the search is, for the progress panel: the free check, then the
    // AI on the best candidates, up to this search's budget.
    const startedAnalyses = listings.filter((listing) => !newMode || newIds.has(listing.id)).map((listing) => analyses[listing.id]).filter(Boolean);
    const aiTarget = Math.max(Math.min(counts.candidates, budget), startedAnalyses.length);
    const aiDone = startedAnalyses.filter((analysis) => analysis.status !== "loading").length;
    const aiBusy = counts.analyzing > 0 || (!analysisPaused.current && counts.waiting > 0 && budgetLeft > 0);
    const phase: SearchPhase =
        searchStatus === "error"
            ? "error"
            : analysisBlocked
              ? "paused"
            : stopped
              ? "stopped"
              : searchStatus === "checking"
                ? pricingRecovery?.status === "checking" ? "pricing" : summary
                    ? digStatus === "checking" ? "discovering" : "filtering"
                    : "finding"
                : aiBusy
                  ? "ai"
                  : "done";

    // Additional work stays within the loaded development batch and is never
    // offered as a way around a server spending pause or a stopped search.
    const showMoreAi = !analysisBlocked && !stopped && counts.waiting > 0 && budgetLeft <= 0;
    const progressActions = (showMoreAi || digStatus !== "idle") && (
        <div className={styles.progressActions}>
            {showMoreAi && (
                <div className={styles.progressButtons}>
                    {showMoreAi && (
                        <button type="button" className={styles.secondary} onClick={() => setBudget((current) => current + Math.min(DEVELOPMENT_SEARCH_LIMIT, counts.waiting))}>
                            Analyze {Math.min(DEVELOPMENT_SEARCH_LIMIT, counts.waiting)} remaining (paid)
                        </button>
                    )}
                </div>
            )}
            {digStatus !== "idle" && (
                <p className={digError ? styles.warning : undefined}>
                    {digError
                        ? digError
                        : digStatus === "checking"
                          ? `Automatically checking for seller mistakes and overlooked listings${digTotal ? `: ${digChecked} of ${digTotal} photo checks` : "…"}. Results keep arriving below.`
                          : `Automatic discovery checked ${digChecked} photos for seller mistakes and overlooked cards. Any verified opportunities appear in Deals.`}
                </p>
            )}
        </div>
    );

    // One tap down: what eBay returned, and the counts behind the four shown.
    const progressDetails = summary && (
        <>
            {newMode ? <p>Loaded a window of {summary.found} newest listings. Skipped {summary.previouslySeen ?? 0} already seen; selected {summary.count} unseen listings for screening.{(summary.deferred ?? 0) > 0 ? ` Another ${summary.deferred} remain in this window for a later scan.` : ""} This scan does not cover all eBay inventory.</p> : <p>
                eBay reports {summary.total.toLocaleString()} results. Loaded {summary.found.toLocaleString()} listings and admitted {summary.count.toLocaleString()} for preliminary screening. This limited window does not cover all eBay inventory.
            </p>}
            <p>
                {counts.candidates} listings are eligible for AI analysis; {counts.mismatched} set aside as other cards, sets, languages or search criteria.
            </p>
            <p>Development searches inspect up to 3 listings. Photo assessments and prices are reused when their evidence is still valid.</p>
        </>
    );

    const incomingItemId = parseListingLink(query)?.itemId;
    const linkWorking = linkStatus === "loading" || Boolean(incomingItemId && directListing?.id === incomingItemId && analyses[incomingItemId]?.status === "loading");
    return (
        <div className={styles.shell}>
            <div className={styles.layout}>
                <main className={styles.main}>
                    <header className={styles.toolbar}>
                        <div className={styles.topRow}>
                            <div className={styles.brand}>
                                <img className={styles.logo} src="/pokeball.png" alt="" width={44} height={44} />
                                <div>
                                    <h1 className={styles.title}>
                                        Pokemon <span>Flipper</span>
                                    </h1>
                                    <p className={styles.tagline}>Find undervalued cards. Flip for profit.</p>
                                </div>
                            </div>

                            {/* The menu, top right where everyone expects it: views, targets, filters, settings. */}
                            <button
                                type="button"
                                className={styles.menuButton}
                                aria-haspopup="dialog"
                                aria-label={activeFilters > 0 ? `Menu, ${activeFilters} filters on` : "Menu"}
                                onClick={() => setDrawerOpen(true)}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 7h16M4 12h16M4 17h16" />
                                </svg>
                                {activeFilters > 0 && <span className={styles.menuBadge}>{activeFilters}</span>}
                            </button>

                            <form className={styles.searchRow} role="search" onSubmit={submitSearch}>
                                <div className={styles.entryModes} role="group" aria-label="Search cards or evaluate a listing">
                                    <button type="button" aria-pressed={!linkInput} onClick={() => chooseEntry(false)}>Search cards</button>
                                    <button type="button" aria-pressed={linkInput} onClick={() => chooseEntry(true)}>Evaluate eBay link</button>
                                </div>
                                <label className={styles.searchField}>
                                    <SearchIcon className={styles.searchIcon} />
                                    <input
                                        ref={searchInput}
                                        type="search"
                                        value={query}
                                        onChange={(event) => changeQuery(event.target.value)}
                                        placeholder={linkInput ? "Paste eBay link" : "Card, set or grade"}
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
                                    >
                                        {searchStatus === "checking" ? <span className={styles.spinner} /> : <ArrowIcon />}
                                    </button>}
                                </label>
                                <button type="submit" className={`${styles.primary} ${linkInput ? styles.linkPrimary : styles.wideOnly}`} aria-label={linkInput ? linkWorking ? "Evaluating…" : "Evaluate listing · paid" : "Find deals"} aria-disabled={linkInput && linkWorking}>
                                    {(linkInput ? linkWorking : searchStatus === "checking") ? (
                                        <span className={styles.spinner} aria-hidden="true" />
                                    ) : (
                                        <SearchIcon className={styles.buttonIcon} />
                                    )}
                                    {linkInput ? linkWorking ? "Evaluating…" : "Evaluate listing · paid" : "Find deals"}
                                </button>
                                <p className={styles.inputHint} id="listing-input-hint">{linkInput ? "Paste or drop a link. Uses paid AI." : "Try “Aquapolis PSA 7 or better holo”, or evaluate an eBay link."}</p>
                            </form>
                        </div>

                        {/* Before the first search there's nothing to count, so phones skip the tabs. */}
                        <nav className={styles.workspaceNav} aria-label="Workspace">
                            <button type="button" aria-label="Search results" aria-pressed={page === "search"} onClick={() => { cancelLink(); setSelectedId(null); setPage("search"); }}>Results</button>
                            <button type="button" aria-pressed={page === "shortlist"} onClick={() => { cancelLink(); cancelPricing(); setSelectedId(null); setPage("shortlist"); void loadShortlist(); }}>Shortlist ({shortlist.length})</button>
                            {(directListing || linkStatus !== "idle") && <button type="button" aria-pressed={page === "listing"} onClick={() => { setSelectedId(null); setPage("listing"); }}>Listing evaluation</button>}
                            {page === "search" && searchStatus !== "idle" && <button type="button" className={styles.findNew} disabled={searchStatus === "checking" || phase === "ai"} onClick={() => void search(undefined, lastQuery.current, true)}>Find new listings</button>}
                        </nav>
                        {saveNotice && <p className={saveNotice.error ? styles.warning : styles.saveNotice} role={saveNotice.error ? "alert" : "status"}>{saveNotice.text}</p>}
                        <SearchControls
                            showSearchOptions={page === "search"}
                            hidden={page !== "search" || searchStatus === "idle"}
                            idle={searchStatus === "idle"}
                            views={{ view, availableViews, groups, allTab, setView }}
                            filters={{ typeFilter, kindFilter, sort, minPrice, maxPrice, minGrade, setTypeFilter, setKindFilter, setSort, changeMinPrice, setMaxPrice, changeMinGrade }}
                            target={{ targets, targetInputs, changeTarget }}
                            settings={{ includeOffers, autoSetting, resultsSetting, changeIncludeOffers, changeAutoSetting, changeResultsSetting }}
                            drawer={{ drawerOpen, setDrawerOpen }}
                            usage={usage} aiUsage={aiUsage}
                        />
                    </header>

                    <AiBudgetStatus budget={aiUsage?.budget} calls={aiUsage?.calls ?? 0} />
                    {analysisBlocked && <AnalysisBlockedNotice message={analysisBlocked} code={analysisBlockCode} onRetry={() => {
                        if (!analysisBlockPolicy(analysisBlockCode).retryLabel) return;
                        // Reuse this search and its existing server allowance.
                        // Completed cards keep their slot; interrupted ones may retry.
                        autoQueued.current = new Set([...autoQueued.current].filter(id => rawAnalyses[id]?.status === "done"));
                        analysisPaused.current = false;
                        setAnalysisBlocked(""); setAnalysisBlockCode(null); setBudget(autoSetting);
                        if (page === "listing" && directListing) void runAnalysis(directListing);
                    }} />}
                    {page === "shortlist" ? <ShortlistView entries={shortlistForDisplay} loading={shortlistLoading} error={shortlistError} refreshing={refreshingSaved} refreshErrors={refreshErrors}
                        onRetry={() => void loadShortlist()} onRefresh={refreshSaved} onRemove={removeSaved} onUpdate={updateSaved} now={now}
                        renderCard={(entry) => <DealCard listing={entry.listing} analysis={analyses[entry.id]} selected={entry.id === selectedId} now={now} years={setYearsByKey} targets={targets} minGrade={minGrade} photoReviewState={photoReviews[entry.id]}
                            onOpen={() => { openPanel(entry.id); if (!analyses[entry.id]) void runAnalysis(entry.listing); }} />} /> : page === "listing" ? <section className={styles.linkEvaluation} aria-labelledby="link-evaluation-heading">
                        <h2 id="link-evaluation-heading">Listing evaluation</h2>
                        {linkStatus === "loading" && <div className={styles.linkLoading} role="status"><p>Reading the listing from eBay…</p><button type="button" className={styles.secondary} onClick={() => { cancelLink(); if (!directListing) setPage("search"); }}>Cancel</button></div>}
                        {linkStatus === "error" && <p role="alert" className={styles.warning}>{linkError}{directListing ? " Your previous listing is still shown below." : ""}</p>}
                        {directListing && linkStatus !== "loading" && !directLanguageEligible && <EnglishOnlyNotice />}
                        {directListing && linkStatus !== "loading" && directLanguageEligible && <div className={styles.directCard}><DealCard listing={directListing} analysis={analyses[directListing.id]} selected={directListing.id === selectedId}
                            now={now} years={setYearsByKey} targets={targets} minGrade={0} photoReviewState={photoReviews[directListing.id]}
                            saved={shortlist.some((entry) => entry.id === directListing.id)} saving={savingIds.has(directListing.id)} onSave={() => void toggleSaved(directListing)}
                            onOpen={() => openPanel(directListing.id)} /></div>}
                        {!directListing && linkStatus === "idle" && <p>Paste an eBay listing link above, then choose Evaluate listing.</p>}
                    </section> : <>
                    {searchStatus !== "idle" && summary && <p className={styles.searchMeaning} role="status">Search criteria: {describeIntent(summary.intent)}.{(summary.intent.grader || summary.intent.minGrade != null || summary.intent.finish) ? " Requested grader, slab grade and finish must match; unconfirmed listings are set aside." : ""}</p>}
                    {searchStatus !== "idle" && (
                        <SearchProgress
                            phase={phase}
                            query={lastQuery.current}
                            error={searchError}
                            ebayTotal={summary?.total ?? null}
                            checked={newMode ? newChecked : digStatus === "idle" ? listings.length : (total ?? 0) + digChecked}
                            total={total === null ? null : total + digTotal}
                            ai={{ done: aiDone, target: aiTarget, analyzing: counts.analyzing, waiting: counts.waiting, failed: startedAnalyses.filter((analysis) => analysis.status === "error").length, paused: Boolean(analysisBlocked) || stopped }}
                            pricing={pricingRecovery}
                            stats={{
                                junk: (summary?.skipped ?? 0) + counts.junk,
                                dropped: counts.dropped,
                                unchecked: counts.unchecked,
                                deals: groups.deals.length,
                            }}
                            usage={
                                usage && {
                                    text: `${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} requests left`,
                                    note: describeUsage(usage),
                                    braking: usage.braking,
                                }
                            }
                            onStop={stopSearch}
                            actions={progressActions}
                            details={progressDetails}
                        />
                    )}
                    {searchStatus !== "idle" && <PricingRetries listings={filtered} reviewCount={groups.review.length} searching={searchStatus === "checking"} recovery={pricingRecovery} analyzed={new Set(Object.entries(analyses).filter(([, analysis]) => analysis.status === "done" || analysis.status === "loading").map(([id]) => id))}
                        busy={pricingBusy} note={pricingNote} onRetry={(tickets) => void retryPrices(tickets)} onCancel={cancelPricing} />}
                    {newMode && <p className={styles.discoveryNote}>Loaded one window of up to 200 newest listings and admitted at most 3 unseen candidates for screening. Earlier results stay in All matching; this is a limited development batch.</p>}

                    {needsWiderSearch && <div className={styles.searchUpdate} role="status">
                        <p>Search filters changed. Run the search again to fetch matching listings. Paid work from the previous filter selection has stopped.</p>
                        <button type="button" className={styles.secondary} onClick={() => {
                            setQuery(lastQuery.current);
                            void search(undefined, lastQuery.current);
                        }}>Rerun search</button>
                    </div>}

                    {searchStatus === "idle" && (
                        <EmptyState title={linkInput ? "Check a listing" : "Find your next flip"}
                            text={linkInput ? "Paste its eBay link above for a photo assessment, resale estimates and a price limit." : "Search for cards across eBay, or evaluate a listing you’ve already found."}>
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
                        </EmptyState>
                    )}

                    {searchStatus !== "idle" &&
                        searchStatus !== "error" &&
                        visible.length === 0 &&
                        !(searchStatus === "checking" && listings.length === 0) &&
                        (view === "deals" && summary ? (
                            <div className={styles.searchUpdate} role="status">
                                <div>
                                    <p><strong>No verified deals in this development batch.</strong></p>
                                    <p>Looked for {describeIntent(summary.intent)}. Admitted {summary.count} candidates from {summary.found} returned; {newMode ? newChecked : listings.length} screening results are saved. This limited batch does not cover all eBay inventory.</p>
                                    <p>{counts.dropped} below your research/value or profit targets · {counts.mismatched} other cards, sets or criteria · {groups.review.length} need specific evidence.</p>
                                    {counts.waiting > 0 && <p>{counts.waiting} still await assessment{analysisBlocked ? " because paid AI is paused or budget-limited" : " in Sorting"}. An unassessed card is not a confirmed deal.</p>}
                                </div>
                                <button type="button" className={styles.secondary} onClick={() => withViewTransition(() => setView("candidates"))}>Open Sorting</button>
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
                        {visible.length} matching {visible.length === 1 ? "listing" : "listings"} in the loaded results, including passes and unfinished assessments. Known wrong cards and junk are excluded. {filtered.filter((listing) => evaluationOf(analyses[listing.id])?.photoCheck).length} AI photo reviews complete; other cards remain preliminary. Each development scan admits at most 3 candidates and does not cover all eBay inventory.
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
                                index={index}
                                // The first screenfuls glide when you sort or filter.
                                transitionName={index < 24 ? transitionName(listing.id) : undefined}
                                analysis={analyses[listing.id]}
                                photoReviewState={photoReviews[listing.id]}
                                saved={shortlist.some((entry) => entry.id === listing.id)}
                                saving={savingIds.has(listing.id)}
                                onSave={() => void toggleSaved(listing)}
                                years={setYearsByKey}
                                minGrade={minGrade}
                                targets={targets}
                                selected={listing.id === selectedId}
                                now={now}
                                onOpen={() => {
                                    openPanel(listing.id);
                                    if (!analyses[listing.id]) void runAnalysis(listing);
                                }}
                            />
                        ))}
                    </div>
                    </>}
                </main>

                {selected && (
                    <DetailPanel
                        listing={selected}
                        closing={panelClosing}
                        minGrade={page === "listing" ? 0 : minGrade}
                        targets={targets}
                        analysis={analyses[selected.id]}
                        now={now}
                        onClose={close}
                        onAnalyze={(fresh) => runAnalysis(selected, fresh)}
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
