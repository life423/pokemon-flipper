import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { prefersReducedMotion, transitionName, withViewTransition } from "./motion";
import type { EbayUsage, Evaluation, ListingSummary, RatingLevel, SearchIntent, Targets } from "./types";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { analysisConcurrency, canAutoAnalyze, meetsMinimumGrade, resultGroup, type ResultGroup } from "../../shared/analysis.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";
import { offerFor, offerWorthMaking } from "../../shared/money/offer.ts";
import { compareListingEvidence, listingSignals } from "../../shared/signals.ts";
import { name } from "./format";
import { evaluateListing, fetchEbayUsage, fetchSetYears, streamDeals, type DealsMessage } from "./api";
import { DealCard } from "./components/DealCard";
import { Drawer } from "./components/Drawer";
import { EmptyState } from "./components/EmptyState";
import { SearchProgress, type SearchPhase } from "./components/SearchProgress";
import { Dropdown } from "./components/Dropdown";
import {
    ArrowIcon,
    ClockIcon,
    CloseIcon,
    DollarIcon,
    GridIcon,
    ReviewIcon,
    SearchIcon,
    SparkleIcon,
    TagIcon,
    TrendIcon,
} from "./components/Icons";
import { DetailPanel } from "./components/DetailPanel";
import { useNow } from "./useNow";
import styles from "./App.module.css";

export type AnalysisState =
    | { status: "loading"; startedAt: number }
    | { status: "done"; evaluation: Evaluation }
    | { status: "error"; message: string };

type View = ResultGroup | "hidden" | "all";

// The views, in order, and what each is called everywhere it appears.
// Long shots come late: auctions unlikely to end at a profitable price.
const VIEWS: View[] = ["deals", "offers", "candidates", "review", "hidden", "longShots", "all"];

// Recent searches, newest first, offered before the next search.
const RECENT_KEY = "recentSearches";
const RECENT_LIMIT = 6;

// Offered before there are recent searches.
const STARTER_SEARCHES = ["1999 charizard", "neo genesis lugia", "base set blastoise", "dark charizard team rocket"];

function readRecentSearches(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
        return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

// Shorter tab names where phones need the room.
const VIEW_SHORT: Partial<Record<View, string>> = { hidden: "Hidden" };
const VIEW_ICONS: Record<View, ReactNode> = {
    deals: <TagIcon />,
    offers: <DollarIcon />,
    candidates: <ClockIcon />,
    longShots: <TrendIcon />,
    review: <ReviewIcon />,
    hidden: <SparkleIcon />,
    all: <GridIcon />,
};

// Quick picks in each target's dropdown: [box text, label]. Empty is Any.
const TARGET_PRESETS: Record<"minProfit" | "minRoi", [string, string][]> = {
    minProfit: [["", "Any"], ["25", "$25"], ["50", "$50"], ["100", "$100"], ["200", "$200"]],
    minRoi: [["", "Any"], ["10", "10%"], ["25", "25%"], ["50", "50%"], ["100", "100%"]],
};

// The search shortcut, as this keyboard writes it.
const SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";

const VIEW_NAMES: Record<View, string> = {
    deals: "Deals",
    offers: "Offers",
    candidates: "Waiting",
    longShots: "Long shots",
    review: "Review",
    hidden: "Hidden finds",
    all: "All",
};
type SortKey = "best" | "overlooked" | "ending" | "priceLow" | "priceHigh";
type TypeFilter = "all" | "AUCTION" | "FIXED_PRICE";
type KindFilter = "all" | "raw" | "graded";

// AI analyses at once, and per search unless you ask for more.
// How many candidates the AI analyzes on its own per search: every one
// that lands in Waiting by default, best first, or a cap, or none.
const ALL = Number.POSITIVE_INFINITY;
const AUTO_OPTIONS = [ALL, 20, 10, 5, 0];
const DEFAULT_AUTO = ALL;
// Saved under a new name, so an old cap doesn't hold over the new default.
const AUTO_KEY = "aiPerSearch";

// "1st Edition Charizard from Base Set, graded": how the search was read.
function describeIntent(intent: SearchIntent): string {
    let text = [intent.printing ? name(intent.printing) : null, intent.cardName ?? "listings for this search"]
        .filter(Boolean)
        .join(" ");

    if (intent.sets.length > 0) text += ` from ${intent.sets.join(" or ")}`;
    if (intent.cardNumber) text += ` #${intent.cardNumber}`;
    if (intent.graded !== null) text += intent.graded ? ", graded" : ", raw";

    return text;
}

type SearchSummary = Extract<DealsMessage, { type: "start" }>;

const LEVEL_ORDER: Record<RatingLevel, number> = { STRONG: 0, GOOD: 1, THIN: 2, LONG_SHOT: 3 };

const evaluationOf = (analysis?: AnalysisState) => (analysis?.status === "done" ? analysis.evaluation : null);
const isDeal = (evaluation: Evaluation | null) => evaluation?.underwriting?.verdict.startsWith("BUY") ?? false;

const SORTS: Record<Exclude<SortKey, "best" | "overlooked">, (a: ListingSummary, b: ListingSummary) => number> = {
    // Listings without an end date (most Buy It Now) go last.
    ending: (a, b) =>
        (a.endTime ? Date.parse(a.endTime) : Infinity) - (b.endTime ? Date.parse(b.endTime) : Infinity),
    priceLow: (a, b) => (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity),
    priceHigh: (a, b) => (b.currentPrice ?? -Infinity) - (a.currentPrice ?? -Infinity),
};

// Your profit and return targets, saved between visits.
function readTargets(): Targets {
    try {
        const saved = JSON.parse(localStorage.getItem("targets") ?? "null");
        if (typeof saved?.minProfit === "number" && typeof saved?.minRoi === "number") return saved;
    } catch {
        // Unreadable: use the defaults.
    }

    return MONEY_CONFIG.targets;
}

// The boxes show whole dollars and percents, and stay empty for "any".
const targetText = (targets: Targets) => ({
    minProfit: targets.minProfit === 0 ? "" : String(targets.minProfit),
    minRoi: targets.minRoi === 0 ? "" : String(Math.round(targets.minRoi * 100)),
});

// eBay results per search: later pages are mostly loose matches, and each
// result can cost an eBay request, so 400 unless you ask for more.
const RESULT_OPTIONS = [200, 400, 1000];
const DEFAULT_RESULTS = 400;

function readResultsSetting(): number {
    try {
        const saved = Number(localStorage.getItem("results"));
        return RESULT_OPTIONS.includes(saved) ? saved : DEFAULT_RESULTS;
    } catch {
        return DEFAULT_RESULTS;
    }
}

function describeUsage(usage: EbayUsage): string {
    const left = `eBay today: ${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} requests left`;

    return usage.braking
        ? `${left}. Listings are checked from their titles only until it resets at midnight Pacific.`
        : `${left}.`;
}

function readAutoSetting(): number {
    try {
        const saved = localStorage.getItem(AUTO_KEY);
        return saved !== null && AUTO_OPTIONS.includes(Number(saved)) ? Number(saved) : DEFAULT_AUTO;
    } catch {
        return DEFAULT_AUTO;
    }
}

function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: [T, ReactNode][];
    onChange: (value: T) => void;
}) {
    // A pill that slides to the chosen option, so a switch shows where it went.
    const group = useRef<HTMLDivElement>(null);
    const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

    useLayoutEffect(() => {
        const measure = () => {
            const active = group.current?.querySelector<HTMLElement>('[aria-pressed="true"]');

            if (!active) return;

            active.scrollIntoView({ block: "nearest", inline: "nearest" });

            const next = { left: active.offsetLeft, width: active.offsetWidth };
            setIndicator((previous) =>
                previous && previous.left === next.left && previous.width === next.width ? previous : next
            );
        };

        measure();

        const observer = new ResizeObserver(measure);
        if (group.current) observer.observe(group.current);

        return () => observer.disconnect();
    }, [value]);

    return (
        <div ref={group} className={styles.segmented} role="group" aria-label={label}>
            {indicator && (
                <span
                    className={styles.indicator}
                    style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
                    aria-hidden="true"
                />
            )}
            {options.map(([option, text]) => (
                <button key={option} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

export function App() {
    const now = useNow(30_000);

    const [query, setQuery] = useState("");
    const [rawListings, setListings] = useState<ListingSummary[]>([]);
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
    // Stops the running search's stream; the server stops checking with it.
    const searchAbort = useRef<AbortController | null>(null);
    const [stopped, setStopped] = useState(false);

    const [view, setView] = useState<View>("deals");
    const [sort, setSort] = useState<SortKey>("best");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
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

    const [autoSetting, setAutoSetting] = useState(readAutoSetting);
    const [resultsSetting, setResultsSetting] = useState(readResultsSetting);

    // Today's eBay allowance, checked on load and after each search.
    const [usage, setUsage] = useState<EbayUsage | null>(null);
    const refreshUsage = useCallback(() => {
        fetchEbayUsage().then(setUsage, () => {});
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
    const [analysisOutcomes, setAnalysisOutcomes] = useState<boolean[]>([]);
    const [includeOffers, setIncludeOffers] = useState(() => {
        try { return localStorage.getItem("includeOffers") === "1"; } catch { return false; }
    });
    const availableViews = VIEWS.filter((key) => key !== "offers" || includeOffers);
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
            rawListings.map((listing) =>
                listing.screen ? { ...listing, screen: retargetScreen(listing.screen, listing.currentPrice, targets, undefined, includeOffers) } : listing
            ),
        [rawListings, targets, includeOffers]
    );

    const analyses = useMemo(() => {
        const repriced: Record<string, AnalysisState> = {};
        const currentListings = new Map(rawListings.map((listing) => [listing.id, listing]));

        for (const [id, analysis] of Object.entries(rawAnalyses)) {
            repriced[id] =
                analysis.status === "done"
                    ? { status: "done", evaluation: retargetEvaluation(analysis.evaluation, targets, currentListings.get(id)) }
                    : analysis;
        }

        return repriced;
    }, [rawAnalyses, targets, rawListings]);

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

    const runAnalysis = useCallback(async (listing: ListingSummary, fresh = false) => {
        setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now() } }));

        try {
            const evaluation = await evaluateListing(listing, { fresh });
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "done", evaluation } }));
            setAnalysisOutcomes((previous) => [...previous.slice(-7), true]);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Analysis failed";
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "error", message } }));
            setAnalysisOutcomes((previous) => [...previous.slice(-7), false]);
        }
    }, []);

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

    // From the search box, or a quick pick with its own text.
    async function search(event?: FormEvent, text = query) {
        event?.preventDefault();

        if (!text.trim()) return;


        const id = ++searchId.current;
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
        setListings([]);
        setTotal(null);
        setSummary(null);
        setSelectedId(null);
        setBudget(autoSetting);
        setView("deals");
        setSearchStatus("checking");

        try {
            await streamDeals(text, { maxResults: resultsSetting, minPrice: Number(minPrice) || 0, signal: controller.signal, targets, includeOffers }, (message) => {
                if (searchId.current !== id) return;
                if (message.type === "start") {
                    setTotal(message.count);
                    setSummary(message);
                }
                if (message.type === "listing") setListings((previous) => previous.some((listing) => listing.id === message.listing.id)
                    ? previous.map((listing) => listing.id === message.listing.id ? message.listing : listing)
                    : [...previous, message.listing]);
                if (message.type === "discovery") {
                    setDigStatus(message.status);
                    setDigTotal(message.total);
                    setDigChecked(message.checked);
                    setDigError(message.note ?? null);
                }
            });

            if (searchId.current === id) setSearchStatus("done");
            refreshUsage();
        } catch (error) {
            refreshUsage();
            if (searchId.current !== id) return;
            setSearchError(error instanceof Error ? error.message : "Search failed");
            setSearchStatus("error");
        }
    }

    // Stop: the server stops checking (no more eBay requests), and nothing
    // new goes to the AI. Analyses already running finish; results stay.
    function stopSearch() {
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

    // The AI looks at the most promising candidates on its own, a couple
    // at a time, up to this search's budget.
    useEffect(() => {
        const running = Object.values(analyses).filter((analysis) => analysis.status === "loading").length;
        let remaining = budget - autoQueued.current.size;
        if (remaining <= 0) return;

        const waiting = listings
            // Long-shot auctions aren't worth the AI.
            .filter((listing) => canAutoAnalyze(listing) && !analyses[listing.id])
            .sort((a, b) => compareAnalysisPriority(a, b, targets));
        let free = analysisConcurrency(waiting.length + running, analysisOutcomes) - running;

        for (const listing of waiting) {
            if (free <= 0 || remaining <= 0) break;

            autoQueued.current.add(listing.id);
            free -= 1;
            remaining -= 1;
            void runAnalysis(listing);
        }
    }, [listings, analyses, budget, runAnalysis, analysisOutcomes, targets]);

    function changeAutoSetting(value: number) {
        setAutoSetting(value);
        // Takes effect mid-search too: Off or a lower cap stops new analyses now.
        setBudget(value === ALL ? ALL : Math.max(autoQueued.current.size, value));

        try {
            localStorage.setItem(AUTO_KEY, String(value));
        } catch {
            // Without storage the setting lasts for this visit.
        }
    }

    const filtered = useMemo(() => {
        const limit = maxPrice === "" ? Infinity : Number(maxPrice);
        const floor = Number(minPrice) || 0;

        return listings
            // Another set, card, or printing than the one searched for, including
            // a reprint the photos gave away.
            .filter((listing) => !listing.match && !evaluationOf(analyses[listing.id])?.identity?.notThisCard)
            .filter((listing) => typeFilter === "all" || listing.buyingOption === typeFilter)
            .filter((listing) => kindFilter === "all" || listing.isGraded === (kindFilter === "graded"))
            .filter((listing) => {
                const evaluation = evaluationOf(analyses[listing.id]);
                return !evaluation || meetsMinimumGrade(evaluation, minGrade);
            })
            .filter((listing) => (listing.currentPrice ?? 0) <= limit)
            .filter((listing) => listing.buyingOption !== "FIXED_PRICE" || (listing.currentPrice ?? 0) >= floor)
            .filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    }, [listings, analyses, typeFilter, kindFilter, maxPrice, minPrice, minGrade, now]);

    const groups = useMemo(() => {
        const grouped: Record<ResultGroup, ListingSummary[]> = { deals: [], offers: [], candidates: [], longShots: [], review: [] };

        for (const listing of filtered) {
            const evaluation = evaluationOf(analyses[listing.id]);
            const group = resultGroup(listing, evaluation, includeOffers);
            if (group) grouped[group].push(listing);
        }

        // Turned up by Dig deeper, shown only while genuine profit still exists:
        // a verified deal or offer, or a candidate still being checked.
        const hidden = filtered.filter((listing) => {
            if (!listing.found) return false;

            const evaluation = evaluationOf(analyses[listing.id]);

            if (evaluation) {
                const verdict = evaluation.underwriting?.verdict;
                return isDeal(evaluation) || (listing.mistakes?.length && verdict === "NEEDS_REVIEW") || (includeOffers && verdict === "PASS" && offerWorthMaking(offerFor(listing, evaluation.underwriting?.best?.maxBid)));
            }

            return listing.screen?.status === "CANDIDATE" || Boolean(listing.mistakes?.length);
        });

        return { ...grouped, hidden, all: filtered };
    }, [filtered, analyses, includeOffers]);

    const visible = useMemo(() => {
        const compareBest = (a: ListingSummary, b: ListingSummary) => {
            const ea = evaluationOf(analyses[a.id]);
            const eb = evaluationOf(analyses[b.id]);
            const ra = isDeal(ea) ? ea?.rating : null;
            const rb = isDeal(eb) ? eb?.rating : null;

            if (ra && rb) {
                if (ra.level !== rb.level) return LEVEL_ORDER[ra.level] - LEVEL_ORDER[rb.level];
                return (eb?.underwriting?.best?.profit ?? 0) - (ea?.underwriting?.best?.profit ?? 0);
            }
            if (ra) return -1;
            if (rb) return 1;

            return compareAnalysisPriority(a, b, targets);
        };

        // The listings with the strongest signs of being overlooked first.
        const compareOverlooked = (a: ListingSummary, b: ListingSummary) => {
            const verified = Number(isDeal(evaluationOf(analyses[b.id]))) - Number(isDeal(evaluationOf(analyses[a.id])));
            return verified || compareListingEvidence(listingSignals(a, evaluationOf(analyses[a.id]), now), listingSignals(b, evaluationOf(analyses[b.id]), now)) || compareBest(a, b);
        };

        return [...groups[view]].sort(sort === "best" ? compareBest : sort === "overlooked" ? compareOverlooked : SORTS[sort]);
    }, [groups, view, sort, analyses, targets, now]);

    const counts = useMemo(() => {
        const count = (status: string) => listings.filter((listing) => listing.screen?.status === status).length;
        const analyzing = listings.filter((listing) => analyses[listing.id]?.status === "loading").length;

        return {
            candidates: listings.filter(canAutoAnalyze).length,
            dropped: count("DROPPED"),
            unchecked: listings.filter((listing) => listing.screen?.status === "UNSCREENED" && !listing.match &&
                !(listing.screen.priceAnomaly && !listing.screen.priceAnomaly.photoChecked)).length,
            mismatched: listings.filter(
                (listing) =>
                    (listing.match && listing.match !== "JUNK") || Boolean(evaluationOf(analyses[listing.id])?.identity?.notThisCard)
            ).length,
            // Junk the AI spotted in titles; the free rules' count comes with the search.
            junk: listings.filter((listing) => listing.match === "JUNK").length,
            analyzing,
            waiting: listings.filter(
                (listing) => canAutoAnalyze(listing) && !analyses[listing.id]
            ).length,
        };
    }, [listings, analyses]);

    const selected = listings.find((listing) => listing.id === selectedId) ?? null;

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
        deals:
            searchStatus === "checking" || counts.analyzing > 0
                ? "No deals yet. Still checking."
                : counts.waiting > 0
                  ? `No deals yet. ${counts.waiting} ${counts.waiting === 1 ? "candidate hasn't" : "candidates haven't"} been analyzed: see Waiting.`
                  : "No deals in this search at the current prices.",
        candidates: "Nothing waiting for the AI.",
        offers: "No offer opportunities within 10% of asking. Seller acceptance is never assumed.",
        longShots: "No long-shot auctions.",
        review: "Nothing needs review.",
        hidden: "No hidden opportunities found. Every search automatically checks for overlooked listings.",
        all: "No listings match the filters.",
    };

    // A view's count, in its color when it holds something worth a look:
    // deals green, review amber, hidden finds blue.
    const COUNT_TONES: Partial<Record<View, string>> = {
        deals: styles.countBuy,
        review: styles.countWatch,
        hidden: styles.countAction,
    };
    const viewCount = (key: View) => {
        const count = groups[key].length;
        return <span className={`${styles.countPill} ${count > 0 ? (COUNT_TONES[key] ?? styles.count) : styles.count}`}>{count}</span>;
    };

    // ⌘K (Ctrl+K elsewhere) jumps to search from anywhere.
    const searchInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                searchInput.current?.focus();
                searchInput.current?.select();
            }
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // Each target's dropdown: quick picks, and a custom amount.
    const targetMenu = (field: keyof Targets, close: () => void) => (
        <div className={styles.targetMenu}>
            <div className={styles.presets}>
                {TARGET_PRESETS[field].map(([text, label]) => (
                    <button
                        key={label}
                        type="button"
                        aria-pressed={targetInputs[field] === text}
                        onClick={() => {
                            changeTarget(field, text);
                            close();
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <label className={styles.field}>
                <span>Custom</span>
                <span className={styles.affix}>
                    {field === "minProfit" && <span>$</span>}
                    <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="5"
                        placeholder="Any"
                        value={targetInputs[field]}
                        onChange={(event) => changeTarget(field, event.target.value)}
                    />
                    {field === "minRoi" && <span>%</span>}
                </span>
            </label>
        </div>
    );

    // Everything narrowing the results, as removable chips under the toolbar.
    const activeChips = [
        targets.minProfit > 0 && {
            key: "profit",
            label: `Min profit ≥ $${targets.minProfit}`,
            clear: () => changeTarget("minProfit", ""),
        },
        targets.minRoi > 0 && {
            key: "roi",
            label: `ROI ≥ ${Math.round(targets.minRoi * 100)}%`,
            clear: () => changeTarget("minRoi", ""),
        },
        typeFilter !== "all" && {
            key: "type",
            label: typeFilter === "AUCTION" ? "Auctions only" : "Buy It Now only",
            clear: () => withViewTransition(() => setTypeFilter("all")),
        },
        kindFilter !== "all" && {
            key: "kind",
            label: kindFilter === "raw" ? "Raw only" : "Graded only",
            clear: () => withViewTransition(() => setKindFilter("all")),
        },
        minPrice !== "" && { key: "min", label: `Buy It Now ≥ $${minPrice}`, clear: () => changeMinPrice("") },
        maxPrice !== "" && { key: "max", label: `Price ≤ $${maxPrice}`, clear: () => setMaxPrice("") },
        minGrade > 0 && { key: "grade", label: `Potential grade ≥ ${minGrade}`, clear: () => changeMinGrade(0) },
    ].filter((chip): chip is { key: string; label: string; clear: () => void } => Boolean(chip));

    const clearAll = () => {
        changeTarget("minProfit", "");
        changeTarget("minRoi", "");
        changeMinPrice("");
        setMaxPrice("");
        changeMinGrade(0);
        withViewTransition(() => {
            setTypeFilter("all");
            setKindFilter("all");
        });
    };

    // Where the search is, for the progress panel: the free check, then the
    // AI on the best candidates, up to this search's budget.
    const startedAnalyses = listings.map((listing) => analyses[listing.id]).filter(Boolean);
    const aiTarget = Math.max(Math.min(counts.candidates, budget), startedAnalyses.length);
    const aiDone = startedAnalyses.filter((analysis) => analysis.status !== "loading").length;
    const aiBusy = counts.analyzing > 0 || (counts.waiting > 0 && budgetLeft > 0);
    const phase: SearchPhase =
        searchStatus === "error"
            ? "error"
            : stopped
              ? "stopped"
              : searchStatus === "checking"
                ? summary
                    ? digStatus === "checking" ? "discovering" : "filtering"
                    : "finding"
                : aiBusy
                  ? "ai"
                  : "done";

    // Discovery always runs; only extra full analyses require a button.
    const showMoreAi = counts.waiting > 0 && budgetLeft <= 0;
    const progressActions = (showMoreAi || digStatus !== "idle") && (
        <div className={styles.progressActions}>
            {showMoreAi && (
                <div className={styles.progressButtons}>
                    {showMoreAi && (
                        <button type="button" className={styles.secondary} onClick={() => setBudget((current) => current + 5)}>
                            Analyze 5 more (paid)
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
                          : `Automatic discovery checked ${digChecked} photos for seller mistakes and overlooked cards. Hidden finds has ${groups.hidden.length} potential ${groups.hidden.length === 1 ? "opportunity" : "opportunities"}.`}
                </p>
            )}
        </div>
    );

    // One tap down: what eBay returned, and the counts behind the four shown.
    const progressDetails = summary && (
        <>
            <p>
                eBay has {summary.total.toLocaleString()} results. Of the first {summary.found.toLocaleString()},{" "}
                {summary.count.toLocaleString()} are {describeIntent(summary.intent)}.
            </p>
            <p>
                {counts.candidates} could be profitable at best; {counts.mismatched} set aside as other sets, cards, or
                languages.
            </p>
            <p>A new search takes a few minutes; repeats are quick.</p>
        </>
    );

    // Min profit and min ROI: in the toolbar on wide screens, in the drawer always.
    const targetFields = (
        <>
            <label className={styles.target} title="Minimum profit after every cost">
                {targetInputs.minProfit !== "" && <span>$</span>}
                <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    placeholder="Any"
                    value={targetInputs.minProfit}
                    onChange={(event) => changeTarget("minProfit", event.target.value)}
                    aria-label="Minimum profit, dollars"
                />
                <span>profit</span>
            </label>
            <label className={styles.target} title="Minimum return on everything you put in">
                <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    placeholder="Any"
                    value={targetInputs.minRoi}
                    onChange={(event) => changeTarget("minRoi", event.target.value)}
                    aria-label="Minimum return, percent"
                />
                <span>{targetInputs.minRoi === "" ? "ROI" : "% ROI"}</span>
            </label>
        </>
    );

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

                            <form className={styles.searchRow} role="search" onSubmit={search}>
                                <label className={styles.searchField}>
                                    <SearchIcon className={styles.searchIcon} />
                                    <input
                                        ref={searchInput}
                                        type="search"
                                        value={query}
                                        onChange={(event) => setQuery(event.target.value)}
                                        placeholder="Search cards, sets, grades, or keywords"
                                        aria-label="Search cards"
                                        aria-keyshortcuts="Meta+K Control+K"
                                    />
                                    {query && (
                                        <button
                                            type="button"
                                            className={styles.clearSearch}
                                            onClick={() => {
                                                setQuery("");
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
                                    <button
                                        type="submit"
                                        className={`${styles.searchSubmit} ${styles.narrowOnly}`}
                                        aria-label="Find deals"
                                        aria-busy={searchStatus === "checking"}
                                    >
                                        {searchStatus === "checking" ? <span className={styles.spinner} /> : <ArrowIcon />}
                                    </button>
                                </label>
                                <button type="submit" className={`${styles.primary} ${styles.wideOnly}`}>
                                    {searchStatus === "checking" ? (
                                        <span className={styles.spinner} aria-hidden="true" />
                                    ) : (
                                        <SearchIcon className={styles.buttonIcon} />
                                    )}
                                    Find deals
                                </button>
                            </form>
                        </div>

                        {/* Before the first search there's nothing to count, so phones skip the tabs. */}
                        <div className={styles.controlPanel} data-idle={searchStatus === "idle" || undefined}>
                            <div className={styles.controlRow}>
                                {/* Every view: tabs on wide screens, a scrolling strip on phones. */}
                                <div className={styles.tabs}>
                                    <Segmented
                                        label="Show"
                                        value={view}
                                        onChange={setView}
                                        options={availableViews.map((key) => [
                                            key,
                                            <span className={styles.tabLabel}>
                                                {VIEW_ICONS[key]}
                                                {VIEW_SHORT[key] ? (
                                                    <>
                                                        <span className={styles.wideOnly}>{VIEW_NAMES[key]}</span>
                                                        <span className={styles.narrowOnly}>{VIEW_SHORT[key]}</span>
                                                    </>
                                                ) : (
                                                    VIEW_NAMES[key]
                                                )}
                                                {viewCount(key)}
                                            </span>,
                                        ])}
                                    />
                                </div>

                                {/* Wide screens: your deal criteria in view. Phones reach them through the menu. */}
                                <div className={`${styles.criteria} ${styles.wideOnly}`}>
                                    <Dropdown
                                        icon={<DollarIcon />}
                                        label="Min profit"
                                        value={targets.minProfit > 0 ? `$${targets.minProfit}` : "Any"}
                                    >
                                        {(close) => targetMenu("minProfit", close)}
                                    </Dropdown>
                                    <Dropdown
                                        icon={<TrendIcon />}
                                        label="ROI"
                                        value={targets.minRoi > 0 ? `${Math.round(targets.minRoi * 100)}%` : "Any"}
                                    >
                                        {(close) => targetMenu("minRoi", close)}
                                    </Dropdown>
                                </div>
                            </div>

                            <div className={`${styles.searchPreferences} ${styles.wideOnly}`}>
                                <label className={styles.offerToggle} title="Include opportunities requiring an unaccepted offer, at most 10% below asking">
                                    <span>Include Best Offers</span>
                                    <input type="checkbox" role="switch" aria-label="Include Best Offer opportunities" checked={includeOffers} onChange={(event) => changeIncludeOffers(event.target.checked)} />
                                </label>
                                <label className={styles.field}>
                                    <span>Minimum Buy It Now price</span>
                                    <span className={styles.affix}><span>$</span><input type="number" min="0" inputMode="decimal" placeholder="Any" value={minPrice} onChange={(event) => changeMinPrice(event.target.value)} /></span>
                                </label>
                                <label className={styles.field} title="Raw cards use the upper end of the AI PSA-style grade range. Slabs use their label grade. Applies after analysis; potential is not a guarantee.">
                                    <span>Minimum potential grade</span>
                                    <select value={minGrade} onChange={(event) => changeMinGrade(Number(event.target.value))}>
                                        <option value={0}>Any grade</option>
                                        {Array.from({ length: 10 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>{grade} or above</option>)}
                                    </select>
                                </label>
                                {minGrade > 0 && <p className={styles.preferenceNote}>Includes cards whose upper estimated grade meets your target. Check the likely grade, confidence and photo evidence.</p>}
                            </div>

                            {/* What's narrowing the results, each one a click to remove. */}
                            {activeChips.length > 0 && (
                                <div className={styles.activeFilters}>
                                    <span className={styles.activeLabel}>Active filters:</span>
                                    {activeChips.map((chip) => (
                                        <button
                                            key={chip.key}
                                            type="button"
                                            className={styles.chip}
                                            onClick={chip.clear}
                                            aria-label={`Remove ${chip.label}`}
                                        >
                                            {chip.label}
                                            <CloseIcon className={styles.chipIcon} />
                                        </button>
                                    ))}
                                    {activeChips.length > 1 && (
                                        <button type="button" className={styles.clearAll} onClick={clearAll}>
                                            Clear all
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>

                        <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Views and filters">
                            <section className={styles.drawerSection}>
                                <h3>Show</h3>
                                <div className={styles.viewList}>
                                    {availableViews.map((key) => (
                                        <button
                                            key={key}
                                            type="button"
                                            aria-current={view === key}
                                            onClick={() => {
                                                setView(key);
                                                setDrawerOpen(false);
                                            }}
                                        >
                                            {VIEW_NAMES[key]}
                                            {viewCount(key)}
                                        </button>
                                    ))}
                                </div>
                            </section>

                            <section className={styles.drawerSection}>
                                <h3>Your targets</h3>
                                <div className={styles.targets}>{targetFields}</div>
                            </section>

                            <section className={styles.drawerSection}>
                                <h3>Filters</h3>
                                <div className={styles.field}>
                                    <span>Listing</span>
                                    <Segmented
                                        label="Listing type"
                                        value={typeFilter}
                                        onChange={(next) => withViewTransition(() => setTypeFilter(next))}
                                        options={[
                                            ["all", "Any"],
                                            ["AUCTION", "Auctions"],
                                            ["FIXED_PRICE", "Buy It Now"],
                                        ]}
                                    />
                                </div>
                                <div className={styles.field}>
                                    <span>Card</span>
                                    <Segmented
                                        label="Raw or graded"
                                        value={kindFilter}
                                        onChange={(next) => withViewTransition(() => setKindFilter(next))}
                                        options={[
                                            ["all", "Any"],
                                            ["raw", "Raw"],
                                            ["graded", "Graded"],
                                        ]}
                                    />
                                </div>
                                <div className={styles.priceRange}>
                                    <label className={styles.field}>
                                        <span>Min price, Buy It Now</span>
                                        <span className={styles.affix}>
                                            <span>$</span>
                                            <input
                                                type="number"
                                                inputMode="decimal"
                                                min="0"
                                                value={minPrice}
                                                onChange={(event) => changeMinPrice(event.target.value)}
                                                placeholder="Any"
                                            />
                                        </span>
                                    </label>
                                    <label className={styles.field}>
                                        <span>Max price</span>
                                        <span className={styles.affix}>
                                            <span>$</span>
                                            <input
                                                type="number"
                                                inputMode="decimal"
                                                min="0"
                                                value={maxPrice}
                                                onChange={(event) => setMaxPrice(event.target.value)}
                                                placeholder="Any"
                                            />
                                        </span>
                                    </label>
                                </div>
                                <label className={styles.field}>
                                    <span>Sort</span>
                                    <select
                                        value={sort}
                                        onChange={(event) => {
                                            const next = event.target.value as SortKey;
                                            withViewTransition(() => setSort(next));
                                        }}
                                    >
                                        <option value="best">Best deal first</option>
                                        <option value="ending">Ending soonest</option>
                                        <option value="priceLow">Price, low to high</option>
                                        <option value="priceHigh">Price, high to low</option>
                                        <option value="overlooked">Most overlooked first</option>
                                    </select>
                                </label>
                                <label className={styles.field}>
                                    <span>Minimum potential grade</span>
                                    <select value={minGrade} onChange={(event) => changeMinGrade(Number(event.target.value))}>
                                        <option value={0}>Any grade</option>
                                        {Array.from({ length: 10 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>{grade} or above</option>)}
                                    </select>
                                </label>
                                <p className={styles.usage}>Uses the upper end of the AI grade range after analysis. Potential is not a guarantee; check the likely grade and photo confidence.</p>
                            </section>

                            <section className={styles.drawerSection}>
                                <h3>Each search</h3>
                                <label className={styles.offerToggle}>
                                    <span>Include deals requiring a Best Offer<small>Offers at most 10% below asking. Acceptance is unknown.</small></span>
                                    <input type="checkbox" role="switch" checked={includeOffers} onChange={(event) => changeIncludeOffers(event.target.checked)} />
                                </label>
                                <label className={styles.field}>
                                    <span>Results per search</span>
                                    <select value={resultsSetting} onChange={(event) => changeResultsSetting(Number(event.target.value))}>
                                        {RESULT_OPTIONS.map((option) => (
                                            <option key={option} value={option}>
                                                {option === 1000 ? "1,000 (more eBay requests)" : option}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className={styles.field}>
                                    <span>Full AI analyses per search</span>
                                    <select value={autoSetting} onChange={(event) => changeAutoSetting(Number(event.target.value))}>
                                        {AUTO_OPTIONS.map((option) => (
                                            <option key={option} value={option}>
                                                {option === ALL ? "All waiting" : option === 0 ? "Off" : `Top ${option}`}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <p className={styles.usage}>Automatic discovery is included in every search. Screening and discovery may use cached or paid AI photo checks; this limit controls full condition analyses.</p>
                                {usage && <p className={styles.usage}>{describeUsage(usage)}</p>}
                            </section>
                        </Drawer>
                    </header>

                    {searchStatus !== "idle" && (
                        <SearchProgress
                            phase={phase}
                            query={lastQuery.current}
                            error={searchError}
                            ebayTotal={summary?.total ?? null}
                            checked={digStatus === "idle" ? listings.length : (total ?? 0) + digChecked}
                            total={total === null ? null : total + digTotal}
                            ai={{ done: aiDone, target: aiTarget, analyzing: counts.analyzing, waiting: counts.waiting }}
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

                    {searchStatus === "idle" && (
                        <EmptyState>
                            {/* One tap to a search: recent ones, or a few to start with. */}
                            <div className={styles.quickPicks}>
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
                            </div>
                        </EmptyState>
                    )}

                    {searchStatus !== "idle" &&
                        searchStatus !== "error" &&
                        visible.length === 0 &&
                        !(searchStatus === "checking" && listings.length === 0) &&
                        (searchStatus === "checking" && view === "deals" ? (
                            <EmptyState
                                framed
                                title="No deals yet"
                                text="Results will appear here as they're found. The search is still running."
                            />
                        ) : (
                            <p className={styles.status}>{emptyText[view]}</p>
                        ))}

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
                                years={setYearsByKey}
                                minGrade={minGrade}
                                selected={listing.id === selectedId}
                                now={now}
                                onOpen={() => {
                                    openPanel(listing.id);
                                    if (!analyses[listing.id]) void runAnalysis(listing);
                                }}
                            />
                        ))}
                    </div>
                </main>

                {selected && (
                    <DetailPanel
                        listing={selected}
                        closing={panelClosing}
                        minGrade={minGrade}
                        analysis={analyses[selected.id]}
                        now={now}
                        onClose={close}
                        onAnalyze={(fresh) => runAnalysis(selected, fresh)}
                    />
                )}
            </div>
        </div>
    );
}
