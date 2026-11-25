import type { ReactNode, Ref, RefObject } from "react";
import type { EbayUsage, Targets } from "../types";
import type { AiUsageDay } from "../../../shared/ai-usage.ts";
import type { ResultGroups, View, SortKey, SearchFilters, TypeFilter, KindFilter } from "./results";
import { ALL, AUTO_OPTIONS } from "./settings";
import { DEVELOPMENT_SEARCH_LIMIT, SEARCH_SOURCE_PAGE_LIMIT } from "../../../shared/research-policy.ts";
import type { MarketplaceOrder } from "../../../shared/listing-filters.ts";
import { MAX_OFFER_DISCOUNT_PERCENT } from "../../../shared/money/cents.ts";
import { describeUsage } from "./presentation";
import { withViewTransition } from "../motion";
import { Drawer } from "../components/Drawer";
import { ClockIcon, CloseIcon, DollarIcon, GridIcon, ReviewIcon, SparkleIcon, TagIcon, TrendDownIcon } from "../components/Icons";
import { TargetFields, type TargetInputProps } from "./TargetFields";
import { ShippingDestination, type ShippingDestinationProps } from "../components/ShippingDestination";
import styles from "../App.module.css";

interface SearchControlsProps {
    shipping?: ShippingDestinationProps;
    searchPage?: boolean;
    hidden: boolean;
    idle: boolean;
    views: {
        view: View;
        availableViews: View[];
        groups: ResultGroups;
        allTab: RefObject<HTMLButtonElement | null>;
        setView: (view: View) => void;
    };
    filters: SearchFilters & {
        sort: SortKey;
        marketplaceOrder: MarketplaceOrder;
        setTypeFilter: (value: TypeFilter) => void;
        setKindFilter: (value: KindFilter) => void;
        setSort: (value: SortKey) => void;
        setMarketplaceOrder: (value: MarketplaceOrder) => void;
        changeMinPrice: (value: string) => void;
        setMaxPrice: (value: string) => void;
        changeMinGrade: (value: number) => void;
    };
    target: TargetInputProps & { targets: Targets };
    settings: {
        includeOffers: boolean;
        autoSetting: number;
        changeIncludeOffers: (value: boolean) => void;
        changeAutoSetting: (value: number) => void;
    };
    drawer: { drawerOpen: boolean; setDrawerOpen: (open: boolean) => void };
    usage: EbayUsage | null;
    aiUsage: AiUsageDay | null;
}

const VIEW_ICONS: Record<View, ReactNode> = {
    new: <SparkleIcon />,
    deals: <TagIcon />,
    bids: <DollarIcon />,
    offers: <DollarIcon />,
    candidates: <ClockIcon />,
    review: <ReviewIcon />,
    losses: <TrendDownIcon />,
    all: <GridIcon />,
};

const VIEW_NAMES: Record<View, string> = {
    new: "New listings",
    deals: "Deals",
    bids: "Bid opportunities",
    offers: "Offers",
    candidates: "Sorting",
    review: "Wait or skip",
    losses: "Projected losses",
    all: "All matching",
};
function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
    buttonRef,
}: {
    label: string;
    value: T;
    options: [T, ReactNode][];
    onChange: (value: T) => void;
    buttonRef?: (value: T) => Ref<HTMLButtonElement> | undefined;
}) {
    return (
        <div className={styles.segmented} role="group" aria-label={label}>
            {options.map(([option, text]) => (
                <button key={option} ref={buttonRef?.(option)} type="button" aria-pressed={value === option} onClick={() => onChange(option)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

function PurchaseFields({ filters }: Pick<SearchControlsProps, "filters">) {
    const { typeFilter, kindFilter, marketplaceOrder, minPrice, maxPrice, setTypeFilter, setKindFilter, setMarketplaceOrder, changeMinPrice, setMaxPrice } = filters;
    return <>
                <label className={styles.field}>
                    <span>Listing format</span>
                    <select value={typeFilter} onChange={({ target: { value } }) => withViewTransition(() => setTypeFilter(value as TypeFilter))}>
                        <option value="FIXED_PRICE">Buy It Now</option>
                        <option value="AUCTION">Auctions ending in under 10 hours</option>
                        <option value="all">Both formats</option>
                    </select>
                </label>
                <label className={styles.field}>
                    <span>Card type</span>
                    <select value={kindFilter} onChange={({ target: { value } }) => withViewTransition(() => setKindFilter(value as KindFilter))}>
                        <option value="all">Both</option>
                        <option value="raw">Raw cards</option>
                        <option value="graded">Graded cards</option>
                    </select>
                </label>
                {typeFilter !== "AUCTION" && <label className={styles.field}>
                    <span>eBay search order</span>
                    <select value={marketplaceOrder} onChange={({ target: { value } }) => setMarketplaceOrder(value === "lowest" ? "lowest" : "newest")}>
                        <option value="newest">Newest first</option>
                        <option value="lowest">Lowest price first</option>
                    </select>
                </label>}
                <label className={styles.field}>
                    <span>Minimum Buy It Now price</span>
                    <span className={styles.affix}><span>$</span><input type="number" min="0" inputMode="decimal" placeholder="Any" value={minPrice} onChange={(event) => changeMinPrice(event.target.value)} /></span>
                </label>
                <label className={styles.field}>
                    <span>Maximum purchase price</span>
                    <span className={styles.affix}><span>$</span><input type="number" min="0" inputMode="decimal" placeholder="Any" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></span>
                </label>
    </>;
}

export function SearchOptions({ filters, target, shipping }: Pick<SearchControlsProps, "filters" | "target" | "shipping">) {
    return <section className={styles.searchOptions} data-marketplace-order={filters.typeFilter !== "AUCTION" || undefined} aria-label="Search options">
        <PurchaseFields filters={filters} />
        <div className={styles.searchTargets}>
            <span>Profit &amp; return targets</span>
            <div className={styles.targets}><TargetFields targetInputs={target.targetInputs} changeTarget={target.changeTarget} /></div>
        </div>
        <ShippingDestination {...shipping} />
        <details className={styles.searchHelp}>
            <summary>How this search works</summary>
            <p>English cards only. Each discovery pass fetches up to {SEARCH_SOURCE_PAGE_LIMIT} listing summaries; the app keeps up to {DEVELOPMENT_SEARCH_LIMIT} results for display and assessment. Screening can continue past {DEVELOPMENT_SEARCH_LIMIT} unresolved rows, and a thin newest-first Buy It Now search can add a lower-price pass. Listing coverage below records exclusions and rows not reached. Identity and condition remain preliminary until photo assessment. All prices by default. The minimum applies to Buy It Now and the maximum to both formats.</p>
        </details>
    </section>;
}

export function SearchControls({ searchPage = false, hidden, idle, views, filters, target, settings, drawer, usage, aiUsage, shipping }: SearchControlsProps) {
    const { view, availableViews, groups, allTab, setView } = views;
    const { typeFilter, kindFilter, sort, minPrice, maxPrice, minGrade, setTypeFilter, setKindFilter, setSort, changeMinPrice, setMaxPrice, changeMinGrade } = filters;
    const { targets, targetInputs, changeTarget } = target;
    const { includeOffers, autoSetting, changeIncludeOffers, changeAutoSetting } = settings;
    const { drawerOpen, setDrawerOpen } = drawer;

    // A view's count, in its color when it holds something worth a look:
    // deals green, review amber.
    const COUNT_TONES: Partial<Record<View, string>> = {
        deals: styles.countBuy,
        bids: styles.countBuy,
        review: styles.countWatch,
    };
    const viewCount = (key: View) => {
        const count = groups[key].length;
        return <span className={`${styles.countPill} ${count > 0 ? (COUNT_TONES[key] ?? styles.count) : styles.count}`}>{count}</span>;
    };
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



    return (
        <>

            <div className={styles.controlPanel} hidden={hidden} data-idle={idle || undefined}>
                <div className={styles.controlRow}>
                    {/* Every view remains visible in wrapping tabs. */}
                    <div className={styles.tabs}>
                        <Segmented
                            label="Show"
                            buttonRef={(key) => key === "all" ? allTab : undefined}
                            value={view}
                            onChange={setView}
                            options={availableViews.map((key) => [
                                key,
                                <span className={styles.tabLabel} data-view={key}>
                                    {VIEW_ICONS[key]}
                                    {VIEW_NAMES[key]}
                                    {viewCount(key)}
                                </span>,
                            ])}
                        />
                    </div>

                    <label className={`${styles.field} ${styles.resultSort}`}>
                        <span>Sort results</span>
                        <select value={sort} onChange={event => setSort(event.target.value as SortKey)}>
                            <option value="best">Best deal first</option>
                            <option value="ending">Ending soonest</option>
                            <option value="priceLow">Price, low to high</option>
                            <option value="priceHigh">Price, high to low</option>
                            <option value="overlooked">Most overlooked first</option>
                        </select>
                    </label>
                </div>

                <details className={styles.resultPreferences}>
                    <summary>More filters and options</summary>
                <div className={styles.searchPreferences}>
                    <label className={styles.offerToggle} title={`Include opportunities that need seller acceptance, up to ${MAX_OFFER_DISCOUNT_PERCENT}% below asking`}>
                        <span>Include Best Offers</span>
                        <input type="checkbox" role="switch" aria-label="Include Best Offer opportunities" checked={includeOffers} onChange={(event) => changeIncludeOffers(event.target.checked)} />
                    </label>
                    <label className={styles.field} title="Raw cards use the upper end of the AI grade range. Slabs use their label grade. Applies after analysis.">
                        <span>Minimum potential grade</span>
                        <select value={minGrade} onChange={(event) => changeMinGrade(Number(event.target.value))}>
                            <option value={0}>Any grade</option>
                            {Array.from({ length: 10 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>{grade} or above</option>)}
                        </select>
                    </label>
                    {minGrade > 0 && <p className={styles.preferenceNote}>Includes cards whose upper estimated grade meets your target. Check the likely grade, confidence and photo evidence.</p>}
                </div>

                </details>
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
                    <h3>Delivery destination</h3>
                    <ShippingDestination {...shipping} />
                </section>
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
                    <div className={styles.targets}><TargetFields targetInputs={targetInputs} changeTarget={changeTarget} /></div>
                </section>

                <section className={styles.drawerSection}>
                    <h3>Filters</h3>
                    <p className={styles.usage}>English cards only. Listings with unconfirmed language remain preliminary.</p>
                    {!searchPage && <PurchaseFields filters={filters} />}
                    <label className={styles.field}>
                        <span>Sort results</span>
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
                    <p className={styles.usage}>Uses the upper end of the AI grade range after analysis. Slabs use their label grade.</p>
                </section>

                <section className={styles.drawerSection}>
                    <h3>Each search</h3>
                    <label className={styles.offerToggle}>
                        <span>Include deals requiring a Best Offer<small>Up to {MAX_OFFER_DISCOUNT_PERCENT}% below asking. The seller would need to accept.</small></span>
                        <input type="checkbox" role="switch" checked={includeOffers} onChange={(event) => changeIncludeOffers(event.target.checked)} />
                    </label>
                    <label className={styles.field}>
                        <span>AI photo assessments</span>
                        <select value={autoSetting} onChange={(event) => changeAutoSetting(Number(event.target.value))}>
                            {AUTO_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {option === ALL ? "Automatic · eligible listings" : option === 0 ? "Off · manual only" : `Top ${option}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className={styles.usage}>New photo work checks identity and either raw condition or the slab label using up to 6 photos. The app tracks confirmed charges and pending reservations for each search.</p>
                    {usage && <p className={styles.usage}>{describeUsage(usage)}</p>}
                </section>
                <section className={styles.drawerSection}>
                    <h3>AI usage</h3>
                    <p className={styles.usage}>{aiUsage ? `${aiUsage.calls} generation requests recorded ${aiUsage.searchId ? "for this search" : "today"}` : "Usage will appear after the local log is available."}</p>
                    {aiUsage && <details className={styles.aiUsage}><summary>View calls by task and model</summary><ul>{aiUsage.stages.map(stage => <li key={`${stage.step}:${stage.model}:${stage.serviceTier ?? "unknown"}`}><strong>{stage.step}</strong><br />{stage.model} · {stage.calls} calls{stage.failed ? ` · ${stage.failed} failed` : ""}<br />{(stage.inputTokens + stage.outputTokens).toLocaleString()} tokens · {stage.images} image inputs</li>)}</ul></details>}
                    <p className={styles.usage}>Local server totals since logging began. Each retry counts as a request. This is usage telemetry, not a billing statement.</p>
                </section>
            </Drawer>
        </>
    );
}
