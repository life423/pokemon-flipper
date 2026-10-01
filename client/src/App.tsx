import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Evaluation, ListingSummary, RatingLevel, SearchIntent, Targets } from "./types";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";
import { name } from "./format";
import { evaluateListing, streamDeals } from "./api";
import { DealCard } from "./components/DealCard";
import { DetailPanel } from "./components/DetailPanel";
import { useNow } from "./useNow";
import styles from "./App.module.css";

export type AnalysisState =
    | { status: "loading"; startedAt: number }
    | { status: "done"; evaluation: Evaluation }
    | { status: "error"; message: string };

type View = "deals" | "candidates" | "review" | "all";
type SortKey = "best" | "ending" | "priceLow" | "priceHigh";
type TypeFilter = "all" | "AUCTION" | "FIXED_PRICE";
type KindFilter = "all" | "raw" | "graded";

// AI analyses at once, and per search unless you ask for more.
const PARALLEL_ANALYSES = 2;
const AUTO_OPTIONS = [0, 5, 10, 20];
const DEFAULT_AUTO = 5;

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

type SearchSummary = Extract<Parameters<Parameters<typeof streamDeals>[1]>[0], { type: "start" }>;

const LEVEL_ORDER: Record<RatingLevel, number> = { STRONG: 0, GOOD: 1, THIN: 2 };

const evaluationOf = (analysis?: AnalysisState) => (analysis?.status === "done" ? analysis.evaluation : null);
const isDeal = (evaluation: Evaluation | null) => evaluation?.underwriting?.verdict.startsWith("BUY") ?? false;

// How far under its best-case max bid a listing sits, from the free check.
function bestCaseRoom(listing: ListingSummary): number {
    const best = listing.screen?.bestCase;

    if (!best || best.maxBid <= 0 || listing.currentPrice === null) return -Infinity;

    return (best.maxBid - listing.currentPrice) / best.maxBid;
}

const SORTS: Record<Exclude<SortKey, "best">, (a: ListingSummary, b: ListingSummary) => number> = {
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

// The boxes show whole dollars and percents.
const targetText = (targets: Targets) => ({
    minProfit: String(targets.minProfit),
    minRoi: String(Math.round(targets.minRoi * 100)),
});

function readAutoSetting(): number {
    try {
        const saved = localStorage.getItem("autoAnalyze");
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
    options: [T, string][];
    onChange: (value: T) => void;
}) {
    return (
        <div className={styles.segmented} role="group" aria-label={label}>
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
    const [searchStatus, setSearchStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
    const [searchError, setSearchError] = useState("");
    const searchId = useRef(0);

    const [view, setView] = useState<View>("deals");
    const [sort, setSort] = useState<SortKey>("best");
    const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
    const [kindFilter, setKindFilter] = useState<KindFilter>("all");
    const [maxPrice, setMaxPrice] = useState("");

    const [autoSetting, setAutoSetting] = useState(readAutoSetting);
    // How many automatic analyses this search may still start.
    const [budget, setBudget] = useState(0);
    const autoQueued = useRef(new Set<string>());

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rawAnalyses, setAnalyses] = useState<Record<string, AnalysisState>>({});

    const [targets, setTargets] = useState<Targets>(readTargets);
    const [targetInputs, setTargetInputs] = useState(() => targetText(readTargets()));

    // Everything re-priced for your targets, from numbers already fetched.
    const listings = useMemo(
        () =>
            rawListings.map((listing) =>
                listing.screen ? { ...listing, screen: retargetScreen(listing.screen, listing.currentPrice, targets) } : listing
            ),
        [rawListings, targets]
    );

    const analyses = useMemo(() => {
        const repriced: Record<string, AnalysisState> = {};

        for (const [id, analysis] of Object.entries(rawAnalyses)) {
            repriced[id] =
                analysis.status === "done"
                    ? { status: "done", evaluation: retargetEvaluation(analysis.evaluation, targets) }
                    : analysis;
        }

        return repriced;
    }, [rawAnalyses, targets]);

    function changeTarget(field: keyof Targets, text: string) {
        setTargetInputs((previous) => ({ ...previous, [field]: text }));

        const value = Number(text);

        // Half-typed or negative: keep the last good target.
        if (text.trim() === "" || !Number.isFinite(value) || value < 0) return;

        const next = { ...targets, [field]: field === "minRoi" ? value / 100 : value };
        setTargets(next);

        try {
            localStorage.setItem("targets", JSON.stringify(next));
        } catch {
            // Without storage the targets last for this visit.
        }
    }

    const runAnalysis = useCallback(async (listing: ListingSummary, fresh = false) => {
        setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "loading", startedAt: Date.now() } }));

        try {
            const evaluation = await evaluateListing(listing.id, { fresh });
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "done", evaluation } }));
        } catch (error) {
            const message = error instanceof Error ? error.message : "Analysis failed";
            setAnalyses((previous) => ({ ...previous, [listing.id]: { status: "error", message } }));
        }
    }, []);

    async function search(event: FormEvent) {
        event.preventDefault();

        const id = ++searchId.current;
        autoQueued.current = new Set();
        setListings([]);
        setTotal(null);
        setSummary(null);
        setSelectedId(null);
        setBudget(autoSetting);
        setView("deals");
        setSearchStatus("checking");

        try {
            await streamDeals(query, (message) => {
                if (searchId.current !== id) return;
                if (message.type === "start") {
                    setTotal(message.count);
                    setSummary(message);
                }
                if (message.type === "listing") setListings((previous) => [...previous, message.listing]);
            });

            if (searchId.current === id) setSearchStatus("done");
        } catch (error) {
            if (searchId.current !== id) return;
            setSearchError(error instanceof Error ? error.message : "Search failed");
            setSearchStatus("error");
        }
    }

    // The AI looks at the most promising candidates on its own, a couple
    // at a time, up to this search's budget.
    useEffect(() => {
        const running = Object.values(analyses).filter((analysis) => analysis.status === "loading").length;
        let free = PARALLEL_ANALYSES - running;
        let remaining = budget - autoQueued.current.size;

        if (free <= 0 || remaining <= 0) return;

        const waiting = listings
            .filter((listing) => listing.screen?.status === "CANDIDATE" && !analyses[listing.id])
            .sort((a, b) => bestCaseRoom(b) - bestCaseRoom(a));

        for (const listing of waiting) {
            if (free <= 0 || remaining <= 0) break;

            autoQueued.current.add(listing.id);
            free -= 1;
            remaining -= 1;
            void runAnalysis(listing);
        }
    }, [listings, analyses, budget, runAnalysis]);

    function changeAutoSetting(value: number) {
        setAutoSetting(value);
        setBudget((current) => Math.max(current, value));

        try {
            localStorage.setItem("autoAnalyze", String(value));
        } catch {
            // Without storage the setting lasts for this visit.
        }
    }

    const filtered = useMemo(() => {
        const limit = maxPrice === "" ? Infinity : Number(maxPrice);

        return listings
            // Another set, card, or printing than the one searched for.
            .filter((listing) => !listing.match)
            .filter((listing) => typeFilter === "all" || listing.buyingOption === typeFilter)
            .filter((listing) => kindFilter === "all" || listing.isGraded === (kindFilter === "graded"))
            .filter((listing) => (listing.currentPrice ?? 0) <= limit)
            .filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    }, [listings, typeFilter, kindFilter, maxPrice, now]);

    const groups = useMemo(() => {
        const deals: ListingSummary[] = [];
        const candidates: ListingSummary[] = [];
        const review: ListingSummary[] = [];

        for (const listing of filtered) {
            const evaluation = evaluationOf(analyses[listing.id]);
            const verdict = evaluation?.underwriting?.verdict;

            if (isDeal(evaluation)) deals.push(listing);
            else if (verdict === "NEEDS_REVIEW" || verdict === "CANT_PRICE") review.push(listing);
            else if (!evaluation && listing.screen?.status === "CANDIDATE") candidates.push(listing);
        }

        return { deals, candidates, review, all: filtered };
    }, [filtered, analyses]);

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

            return bestCaseRoom(b) - bestCaseRoom(a);
        };

        return [...groups[view]].sort(sort === "best" ? compareBest : SORTS[sort]);
    }, [groups, view, sort, analyses]);

    const counts = useMemo(() => {
        const count = (status: string) => listings.filter((listing) => listing.screen?.status === status).length;
        const analyzing = Object.values(analyses).filter((analysis) => analysis.status === "loading").length;

        return {
            candidates: count("CANDIDATE"),
            dropped: count("DROPPED"),
            unchecked: listings.filter((listing) => listing.screen?.status === "UNSCREENED" && !listing.match).length,
            mismatched: listings.filter((listing) => listing.match).length,
            analyzing,
            waiting: listings.filter((listing) => listing.screen?.status === "CANDIDATE" && !analyses[listing.id]).length,
        };
    }, [listings, analyses]);

    const selected = listings.find((listing) => listing.id === selectedId) ?? null;
    const close = useCallback(() => setSelectedId(null), []);
    const budgetLeft = budget - autoQueued.current.size;

    const emptyText: Record<View, string> = {
        deals:
            searchStatus === "checking" || counts.analyzing > 0
                ? "No deals yet. Still checking."
                : counts.waiting > 0
                  ? `No deals yet. ${counts.waiting} ${counts.waiting === 1 ? "candidate hasn't" : "candidates haven't"} been analyzed: see Waiting.`
                  : "No deals in this search at the current prices.",
        candidates: "Nothing waiting for the AI.",
        review: "Nothing needs review.",
        all: "No listings match the filters.",
    };

    return (
        <div className={styles.shell}>
            <div className={styles.layout}>
                <main className={styles.main}>
                    <header className={styles.header}>
                        <h1 className={styles.title}>Pokemon Flipper</h1>
                    </header>

                    <form className={styles.search} role="search" onSubmit={search}>
                        <input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Charizard, Lugia 9/111, Neo Genesis PSA 8"
                            aria-label="Search cards"
                        />
                        <button type="submit" className={styles.primary}>
                            Find deals
                        </button>
                    </form>

                    {searchStatus !== "idle" && (
                        <section className={styles.funnel} aria-live="polite">
                            {searchStatus === "error" ? (
                                <p className={styles.error}>{searchError}</p>
                            ) : (
                                <>
                                    <p>
                                        {summary &&
                                            `eBay has ${summary.total.toLocaleString()} results. Of the first ${summary.found.toLocaleString()}, ${summary.count.toLocaleString()} are ${describeIntent(summary.intent)}. `}
                                        {searchStatus === "checking"
                                            ? `Checking them for free: ${listings.length} of ${total ?? "..."}. A new search takes a few minutes; repeats are quick.`
                                            : `All ${listings.length} checked for free.`}
                                    </p>
                                    <dl className={styles.funnelNumbers}>
                                        <div>
                                            <dt>Could be profitable</dt>
                                            <dd>{counts.candidates}</dd>
                                        </div>
                                        <div>
                                            <dt>Too pricey even at best</dt>
                                            <dd>{counts.dropped}</dd>
                                        </div>
                                        <div>
                                            <dt>Couldn't check</dt>
                                            <dd>{counts.unchecked}</dd>
                                        </div>
                                        <div>
                                            <dt>Set aside: other sets, cards, languages</dt>
                                            <dd>{counts.mismatched}</dd>
                                        </div>
                                        <div>
                                            <dt>Deals</dt>
                                            <dd className={styles.dealCount}>{groups.deals.length}</dd>
                                        </div>
                                    </dl>
                                    <div className={styles.aiRow}>
                                        <p>
                                            {counts.analyzing > 0
                                                ? `AI is analyzing ${counts.analyzing} now.`
                                                : counts.waiting > 0
                                                  ? `${counts.waiting} ${counts.waiting === 1 ? "candidate is" : "candidates are"} waiting for the AI.`
                                                  : "The AI has looked at every candidate."}
                                        </p>
                                        {counts.waiting > 0 && budgetLeft <= 0 && (
                                            <button
                                                type="button"
                                                className={styles.secondary}
                                                onClick={() => setBudget((current) => current + 5)}
                                            >
                                                Analyze 5 more (paid)
                                            </button>
                                        )}
                                    </div>
                                </>
                            )}
                        </section>
                    )}

                    <div className={styles.filters}>
                        <label className={styles.field}>
                            <span>Min profit</span>
                            <span className={styles.affix}>
                                <span>$</span>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="5"
                                    value={targetInputs.minProfit}
                                    onChange={(event) => changeTarget("minProfit", event.target.value)}
                                />
                            </span>
                        </label>
                        <label className={styles.field}>
                            <span>Min ROI</span>
                            <span className={styles.affix}>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="5"
                                    value={targetInputs.minRoi}
                                    onChange={(event) => changeTarget("minRoi", event.target.value)}
                                />
                                <span>%</span>
                            </span>
                        </label>
                        <Segmented
                            label="Show"
                            value={view}
                            onChange={setView}
                            options={[
                                ["deals", `Deals ${groups.deals.length}`],
                                ["candidates", `Waiting ${groups.candidates.length}`],
                                ["review", `Review ${groups.review.length}`],
                                ["all", `All ${groups.all.length}`],
                            ]}
                        />
                        <Segmented
                            label="Listing type"
                            value={typeFilter}
                            onChange={setTypeFilter}
                            options={[
                                ["all", "Any"],
                                ["AUCTION", "Auctions"],
                                ["FIXED_PRICE", "Buy It Now"],
                            ]}
                        />
                        <Segmented
                            label="Raw or graded"
                            value={kindFilter}
                            onChange={setKindFilter}
                            options={[
                                ["all", "Any"],
                                ["raw", "Raw"],
                                ["graded", "Graded"],
                            ]}
                        />
                        <label className={styles.field}>
                            <span>Max price</span>
                            <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                value={maxPrice}
                                onChange={(event) => setMaxPrice(event.target.value)}
                                placeholder="Any"
                            />
                        </label>
                        <label className={styles.field}>
                            <span>Sort</span>
                            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
                                <option value="best">Best deal first</option>
                                <option value="ending">Ending soonest</option>
                                <option value="priceLow">Price, low to high</option>
                                <option value="priceHigh">Price, high to low</option>
                            </select>
                        </label>
                        <label className={styles.field}>
                            <span>AI per search</span>
                            <select value={autoSetting} onChange={(event) => changeAutoSetting(Number(event.target.value))}>
                                {AUTO_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {option === 0 ? "Off" : `Top ${option}`}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    {searchStatus === "idle" && (
                        <p className={styles.status}>
                            Search for a card. Every listing gets a free check first; only the ones that could
                            be profitable go to the AI.
                        </p>
                    )}

                    {searchStatus !== "idle" && visible.length === 0 && (
                        <p className={styles.status}>{emptyText[view]}</p>
                    )}

                    <div className={styles.results}>
                        {visible.map((listing) => (
                            <DealCard
                                key={listing.id}
                                listing={listing}
                                analysis={analyses[listing.id]}
                                selected={listing.id === selectedId}
                                now={now}
                                onOpen={() => {
                                    setSelectedId(listing.id);
                                    if (!analyses[listing.id]) void runAnalysis(listing);
                                }}
                            />
                        ))}
                    </div>
                </main>

                {selected && (
                    <DetailPanel
                        // A new listing opens at the top of the panel.
                        key={selected.id}
                        listing={selected}
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
