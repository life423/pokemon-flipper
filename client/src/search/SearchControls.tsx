import type { ReactNode, Ref, RefObject } from "react";
import type { EbayUsage, Targets } from "../types";
import type { AiUsageDay } from "../../../shared/ai-usage.ts";
import type { ResultGroups, View, SortKey, SearchFilters, TypeFilter, KindFilter } from "./results";
import { ALL, AUTO_OPTIONS, RESULT_OPTIONS } from "./settings";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../../shared/research-policy.ts";
import { describeUsage } from "./presentation";
import { withViewTransition } from "../motion";
import { Drawer } from "../components/Drawer";
import { Dropdown } from "../components/Dropdown";
import { ClockIcon, CloseIcon, DollarIcon, GridIcon, ReviewIcon, SparkleIcon, TagIcon, TrendIcon } from "../components/Icons";
import { TargetFields, TargetMenu, type TargetInputProps } from "./TargetFields";
import styles from "../App.module.css";

interface SearchControlsProps {
    showSearchOptions?: boolean;
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
        setTypeFilter: (value: TypeFilter) => void;
        setKindFilter: (value: KindFilter) => void;
        setSort: (value: SortKey) => void;
        changeMinPrice: (value: string) => void;
        setMaxPrice: (value: string) => void;
        changeMinGrade: (value: number) => void;
    };
    target: TargetInputProps & { targets: Targets };
    settings: {
        includeOffers: boolean;
        autoSetting: number;
        resultsSetting: number;
        changeIncludeOffers: (value: boolean) => void;
        changeAutoSetting: (value: number) => void;
        changeResultsSetting: (value: number) => void;
    };
    drawer: { drawerOpen: boolean; setDrawerOpen: (open: boolean) => void };
    usage: EbayUsage | null;
    aiUsage: AiUsageDay | null;
}

const VIEW_ICONS: Record<View, ReactNode> = {
    new: <SparkleIcon />,
    deals: <TagIcon />,
    offers: <DollarIcon />,
    candidates: <ClockIcon />,
    review: <ReviewIcon />,
    all: <GridIcon />,
};

const VIEW_NAMES: Record<View, string> = {
    new: "New listings",
    deals: "Deals",
    offers: "Offers",
    candidates: "Sorting",
    review: "Needs attention",
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

export function SearchControls({ showSearchOptions = false, hidden, idle, views, filters, target, settings, drawer, usage, aiUsage }: SearchControlsProps) {
    const { view, availableViews, groups, allTab, setView } = views;
    const { typeFilter, kindFilter, sort, minPrice, maxPrice, minGrade, setTypeFilter, setKindFilter, setSort, changeMinPrice, setMaxPrice, changeMinGrade } = filters;
    const { targets, targetInputs, changeTarget } = target;
    const { includeOffers, autoSetting, resultsSetting, changeIncludeOffers, changeAutoSetting, changeResultsSetting } = settings;
    const { drawerOpen, setDrawerOpen } = drawer;

    // A view's count, in its color when it holds something worth a look:
    // deals green, review amber.
    const COUNT_TONES: Partial<Record<View, string>> = {
        deals: styles.countBuy,
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

    const purchaseFields = <>
                <label className={styles.field}>
                    <span>Listing format</span>
                    <select value={typeFilter} onChange={({ target: { value } }) => withViewTransition(() => setTypeFilter(value as TypeFilter))}>
                        <option value="FIXED_PRICE">Buy It Now</option>
                        <option value="AUCTION">Auctions ending within 12 hours</option>
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
                <label className={styles.field}>
                    <span>Minimum Buy It Now price</span>
                    <span className={styles.affix}><span>$</span><input type="number" min="0" inputMode="decimal" placeholder="Any" value={minPrice} onChange={(event) => changeMinPrice(event.target.value)} /></span>
                </label>
                <label className={styles.field}>
                    <span>Maximum purchase price</span>
                    <span className={styles.affix}><span>$</span><input type="number" min="0" inputMode="decimal" placeholder="Any" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></span>
                </label>
    </>;

    return (
        <>
            {showSearchOptions && <div className={styles.searchOptions} role="group" aria-label="Search options">
                {purchaseFields}
                <p className={styles.preferenceNote}>English cards only. Up to {DEVELOPMENT_SEARCH_LIMIT} matching listings per scan. Recent sold evidence informs priority before automatic AI, within the search’s AI budget. Identity and condition remain preliminary until photo assessment. All prices by default; the minimum applies to Buy It Now and the maximum to both formats.</p>
            </div>}
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
                                <span className={styles.tabLabel}>
                                    {VIEW_ICONS[key]}
                                    {VIEW_NAMES[key]}
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
                            {(close) => <TargetMenu field="minProfit" close={close} targetInputs={targetInputs} changeTarget={changeTarget} />}
                        </Dropdown>
                        <Dropdown
                            icon={<TrendIcon />}
                            label="ROI"
                            value={targets.minRoi > 0 ? `${Math.round(targets.minRoi * 100)}%` : "Any"}
                        >
                            {(close) => <TargetMenu field="minRoi" close={close} targetInputs={targetInputs} changeTarget={changeTarget} />}
                        </Dropdown>
                    </div>
                </div>

                <div className={`${styles.searchPreferences} ${styles.wideOnly}`}>
                    <label className={styles.offerToggle} title="Include opportunities requiring an unaccepted offer, at most 10% below asking">
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
                    <div className={styles.targets}><TargetFields targetInputs={targetInputs} changeTarget={changeTarget} /></div>
                </section>

                <section className={styles.drawerSection}>
                    <h3>Filters</h3>
                    <p className={styles.usage}>English cards only. Listings with unconfirmed language remain preliminary.</p>
                    {!showSearchOptions && purchaseFields}
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
                    <p className={styles.usage}>Uses the upper end of the AI grade range after analysis. Slabs use their label grade.</p>
                </section>

                <section className={styles.drawerSection}>
                    <h3>Each search</h3>
                    <label className={styles.offerToggle}>
                        <span>Include deals requiring a Best Offer<small>Offers at most 10% below asking. Acceptance is unknown.</small></span>
                        <input type="checkbox" role="switch" checked={includeOffers} onChange={(event) => changeIncludeOffers(event.target.checked)} />
                    </label>
                    <label className={styles.field}>
                        <span>Matching listings per search</span>
                        <select value={resultsSetting} onChange={(event) => changeResultsSetting(Number(event.target.value))}>
                            {RESULT_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {option === 1000 ? "1,000 (more eBay requests)" : option}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className={styles.field}>
                        <span>AI photo assessments</span>
                        <select value={autoSetting} onChange={(event) => changeAutoSetting(Number(event.target.value))}>
                            {AUTO_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {option === ALL ? "Automatic · within budget" : option === 0 ? "Off · manual only" : `Top ${option}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <p className={styles.usage}>Saved evidence is reused first. New photo work checks identity and either raw condition or the slab label in one assessment of up to 6 photos. All paid stages share the search’s AI budget; unconfirmed charges remain counted against it. A pause keeps saved evidence available.</p>
                    {usage && <p className={styles.usage}>{describeUsage(usage)}</p>}
                </section>
                <section className={styles.drawerSection}>
                    <h3>AI usage</h3>
                    <p className={styles.usage}>{aiUsage ? `${aiUsage.calls} generation requests recorded ${aiUsage.searchId ? "for this search" : "today"}` : "Usage will appear after the local log is available."}</p>
                    {aiUsage && <details className={styles.aiUsage}><summary>View calls by task and model</summary><ul>{aiUsage.stages.map(stage => <li key={`${stage.step}:${stage.model}:${stage.serviceTier ?? "unknown"}`}><strong>{stage.step}</strong><br />{stage.model} · {stage.calls} calls{stage.failed ? ` · ${stage.failed} failed` : ""}<br />{(stage.inputTokens + stage.outputTokens).toLocaleString()} tokens · {stage.images} image inputs</li>)}</ul></details>}
                    <p className={styles.usage}>Local server totals since logging began. Retries count separately; reused answers add no request. This is usage telemetry, not a billing statement.</p>
                </section>
            </Drawer>
        </>
    );
}
