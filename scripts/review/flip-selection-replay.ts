import { flipPreviewMenu, orderFlipPreviewCopies, type PreviewLead } from "../../server/deals/flip-preview-selection.ts";
import { huntPhotoIdentityIssue } from "../../server/analysis/deal-hunt-market-checks.ts";
import { dealHuntCandidate } from "../../server/analysis/deal-hunt-evidence.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { photoFitsSearch, type PhotoInspection } from "../../server/ai/photo-find.ts";
import { screenListingWithoutAi } from "../../server/deals/screen-listing.ts";
import { setMatches, titleMatches } from "../../server/search/relevance.ts";
import { normalizedPhoto, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import { matchesListingFilters } from "../../shared/listing-filters.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { evaluatedCriteriaMismatch } from "../../shared/search-criteria.ts";
import { meetsMinimumGrade } from "../../shared/analysis.ts";
import type { Evaluation, ListingSummary, SearchIntent } from "../../shared/types.ts";
import type { readFlipEvents } from "../../server/analysis/flip-diagnostic.ts";

export interface PhotoArchive {
    evaluations: Map<string, Evaluation[]>;
    fronts: Map<string, PhotoInspection[]>;
}

interface Copy {
    id: string;
    query: string;
    title?: string;
    images?: string[];
    row?: ListingSummary;
    reason?: string;
    admitted?: boolean;
    deferred?: boolean;
}

// This is a historical selection audit. A matching front can disprove a
// title exclusion, but cannot prove price, condition or a profit.
function identityEvidence(copy: Copy, intent: SearchIntent | undefined, archive: PhotoArchive) {
    if (!intent || !copy.images?.length) return "unknown";
    const labels = new Set<string>();
    for (const e of archive.evaluations.get(copy.id) ?? []) {
        if (e.listing.title.trim() !== copy.title?.trim() || !searchPhotosFitDetails(copy.images, e.listing.photos ?? []) ||
            e.identity?.notThisCard || huntPhotoIdentityIssue(e)) continue;
        labels.add(evaluatedCriteriaMismatch(e, intent) ? "different" : "matches");
    }
    // The legacy front reader only authenticates visible identity fields.
    // Grading and release-year constraints require a full evaluation above.
    if (intent.graded == null && !intent.grader && intent.minGrade == null && intent.maxGrade == null &&
        intent.minYear == null && intent.maxYear == null) {
        for (const photo of archive.fronts.get(normalizedPhoto(copy.images[0])) ?? []) {
            if (photoFitsSearch(photo, intent)) labels.add("matches");
        }
    }
    return labels.size === 1 ? [...labels][0] : "unknown";
}

export async function replayFlipSelection(pass: Awaited<ReturnType<typeof readFlipEvents>>, archive: PhotoArchive) {
    const { events, damagedLines } = pass;
    if (!events.length) return;
    const start = events.find(e => e.event === "started")?.evidence.request;
    if (start?.filters?.typeFilter !== "FIXED_PRICE") return;
    if (events.some(e => e.pass !== events[0].pass || e.searchId !== events[0].searchId || e.version !== 1))
        throw new Error("Mixed or incompatible saved search events.");
    const copies = new Map<string, Copy>(), intents = new Map<string, SearchIntent>();
    const selections = [], poolRows = new Map<string, ListingSummary>();
    const previewed = new Set<string>(), inspected = new Set<string>(), won = new Set<string>();
    const observations = new Map<string, string>();
    const get = (id: string, query: string) => {
        const key = JSON.stringify([query, id]);
        if (!copies.has(key)) copies.set(key, { id, query });
        return copies.get(key)!;
    };
    function snapshot(row: ListingSummary, query: string) {
        const copy = get(row.id, query);
        Object.assign(copy, { row, title: row.title, images: row.images });
    }
    for (const e of events) {
        const v = e.evidence;
        if (e.event === "page") {
            intents.set(v.query, v.intent);
            for (const row of v.page.listings) snapshot(row, v.query);
            for (const r of v.page.rejections ?? []) {
                const copy = get(r.id, v.query);
                copy.reason = r.reason;
                if (r.listing?.id === r.id) snapshot(r.listing, v.query);
            }
        } else if (e.event === "screened") {
            for (const row of v.listings ?? []) {
                snapshot(row, v.query);
                poolRows.set(row.id, row);
            }
            for (const row of v.excludedPrices ?? []) snapshot(row, v.query);
            for (const d of v.dispositions) {
                const copy = get(d.id, v.query);
                if (d.outcome === "NOT_REACHED") copy.deferred = true;
                else if (d.reason !== "ALREADY_SEEN") copy.reason = d.reason;
            }
        } else if (e.event === "queue") {
            for (const d of v.dispositions) {
                const copy = get(d.id, v.query);
                if (d.reason === "ELIGIBLE_FOR_REVIEW" || d.reason === "ALREADY_QUEUED") copy.admitted = true;
                else copy.reason = d.reason;
            }
        } else if (e.event === "selection") {
            if (v.source === "vision") {
                for (const id of v.seen) previewed.add(id);
                for (const lead of v.leads as PreviewLead[]) observations.set(lead.id, lead.observation);
            }
            const pool = (v.previous as string[]).map(id => poolRows.get(id));
            if (!pool.length || !pool.every((row): row is ListingSummary => !!row) || !start.targets) continue;
            const at = Date.parse(e.at), { baseline, menu } = flipPreviewMenu(pool, start.targets, at);
            const eligible = new Set(menu.map(row => row.id));
            const seen = ((v.seen ?? []) as string[]).filter(id => eligible.has(id));
            const leads = ((v.leads ?? []) as PreviewLead[]).filter(lead => seen.includes(lead.id));
            const order = orderFlipPreviewCopies(pool, { cheapest: baseline, seen, leads }, start.targets, at);
            selections.push({ baseline, order, recorded: v.ordered ?? [], menu: [...eligible], seen, leads: leads.map(l => l.id) });
        } else if (e.event === "check" && v.action === "inspect_photos") inspected.add(v.id);
        else if (e.event === "finished" && v.decision === "BUY" && v.destination?.listingId) won.add(v.destination.listingId);
    }
    const rows = [];
    for (const copy of copies.values()) {
        const { id, query, reason, row } = copy;
        const intent = intents.get(query);
        const physical = identityEvidence(copy, intent, archive);
        const beforePhotos = !!reason && !copy.admitted && !previewed.has(id) && !inspected.has(id);
        let clearsTitleScreen = false;
        // Re-run the seller-title checks on actual historical name rejections.
        // This does not reconstruct missing prices or declare a purchase.
        if (beforePhotos && reason === "OTHER_CARD" && intent && row && titleMatches(row.title, intent)) {
            const screened = await screenListingWithoutAi(row, intent, undefined, async title => readTitleByRules(title, intent.sets));
            clearsTitleScreen = !screened.match && setMatches(screened.screen?.card?.set, intent, screened.screen?.card?.cardNumber);
        }
        const cases: string[] = [];
        if (row?.mistakes?.length || row?.researchIdentity || clearsTitleScreen) cases.push("possible seller mistake");
        if (row?.screen?.evidence?.mainPhoto === "CANT_TELL" || /\b(?:glare|blurred|blurry|obscured|poorly lit)\b/i.test(observations.get(id) ?? "")) cases.push("unclear photo");
        const evaluated = (archive.evaluations.get(id) ?? []).filter(e => copy.images?.length &&
            e.listing.title.trim() === copy.title?.trim() && searchPhotosFitDetails(copy.images, e.listing.photos ?? []) &&
            !e.identity?.notThisCard && !huntPhotoIdentityIssue(e));
        const raw = evaluated.filter(e => !e.slab);
        const damaged = raw.some(e => e.condition?.rawCondition === "DAMAGED");
        const clean = raw.some(e => e.condition?.rawCondition === "NEAR_MINT" || e.condition?.rawCondition === "MINT");
        if (damaged) cases.push("photo-assessed damaged");
        if (clean) cases.push("photo-assessed clean");
        const alternative = row?.askingSample?.lowestOtherDelivered;
        if (clean && row?.shipping != null && row.currentPrice != null && alternative != null &&
            row.shipping + row.currentPrice <= alternative) cases.push("clean at or below another comparable ask");
        // Independently replay archived evidence, including evaluations from
        // outside this pass. Its photos, price, ZIP, targets and timestamps
        // must still belong to these historical terms.
        const supportedMargin = !!row && !!intent && evaluated.some(e => {
            if (e.listing.price !== row.currentPrice || e.listing.shipping !== row.shipping ||
                (e.listing.shippingDestination ?? null) !== (row.shippingDestination ?? null) ||
                evaluatedCriteriaMismatch(e, intent) || !matchesListingFilters(row, start.filters, e, intent.graded) ||
                !meetsMinimumGrade(e, start.minPotentialGrade ?? 0)) return false;
            const snapshotAt = Date.parse(row.termsCheckedAt ?? "");
            const at = Math.max(snapshotAt, Date.parse(e.listing.termsCheckedAt ?? ""), Date.parse(e.pricesCheckedAt ?? ""), Date.parse(e.answeredAt ?? ""));
            if (!Number.isFinite(at) || at - snapshotAt > BEST_BUY_TERMS_MAX_AGE_MS) return false;
            if (!e.slab && !e.rawPricing?.prices?.some(p => p.comps?.sales.length) ||
                e.slab && !e.slabPricing?.summary?.sales.length) return false;
            const result = dealHuntCandidate(e, "resell", at, undefined, start.targets, start.filters.maxPrice,
                { preferRecentSales: true })?.outcome(new Set(["check_listing", "inspect_photos", e.slab ? "check_sales" : "check_raw_resale"]));
            return result?.decision === "BUY" && !!result.verifiedPurchase;
        });
        if (damaged && supportedMargin) cases.push("damaged with independently supported margin");
        rows.push({ id, query, title: copy.title, reason, beforePhotos, hasSnapshot: !!copy.title && !!copy.images?.length,
            deferredOnly: !!copy.deferred && !reason && !copy.admitted && !inspected.has(id) && !previewed.has(id),
            previewed: previewed.has(id), galleryStarted: inspected.has(id), physical, clearsTitleScreen, supportedMargin, cases, confirmedBuy: won.has(id) });
    }
    return { pass: events[0].pass, complete: events.some(e => e.event === "finished"),
        contiguous: damagedLines === 0 && events.every((e,i) => e.index === i + 1), rows, selections };
}
