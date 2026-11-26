import sharp from "sharp";
import { cheapestComparableFirst, deliveredAsk, sampleRawAsks } from "../../shared/bin-market-comparison.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { listingDisclosesCardCrease } from "../../shared/ebay-condition-notes.ts";
import { fullSizeEbayPhoto, normalizedPhoto } from "../../shared/listing-evidence.ts";
import { hasExactSoldScope } from "../../shared/sold-evidence.ts";
import type { ListingSummary, Targets } from "../../shared/types.ts";
import { downloadEbayImage } from "../ai/image-input.ts";
import { BOUNDED_VISION_MODEL } from "../ai/policy.ts";
import { createModelExperimentRunner } from "../analysis/model-experiment.ts";
import { discoveryMarketKey, resaleReviewBand, resaleReviewPriority } from "./discovery-order.ts";

const rank = createModelExperimentRunner();
export interface PreviewLead { id: string; observation: string; question: string }

// The accepted preview describes a visible front. Never treat a proposed gallery
// question, glare, a missing photo or a seller's "Mint" claim as physical evidence.
function previewWear(observation: string) {
    return observation.split(/[.;,!?]/).some(clause =>
        !/\b(?:no|not|without|whether|cannot|unclear|may be|might be|holder|sleeve|toploader|case)\b/i.test(clause) &&
        /\b(?:(?:substantial|heavy|severe|major|extensive)\s+(?:(?:edge|corner|surface|border)[\s/-]+){0,2}(?:wear|whitening|creasing)|(?:visible|clear|multiple|deep|pronounced)\s+(?:(?:diagonal|horizontal|vertical)\s+)?creases?)\b/i.test(clause));
}

export function orderFlipPreviewCopies(rows: ListingSummary[], selection: { cheapest: string[]; leads: PreviewLead[]; seen: string[] },
    targets: Targets, now: number): string[] {
    const byId = new Map(rows.map(row => [row.id, row]));
    const leads = new Map(selection.leads.map(lead => [lead.id, lead.observation]));
    const seen = new Set(selection.seen);
    const order = [...new Set([...leads.keys(), ...selection.cheapest])].filter(id => !byId.get(id)?.isGraded);
    const groups = new Map<string, { slots: number[]; ordinary: string[]; worn: string[] }>();
    for (const [slot, id] of order.entries()) {
        const row = byId.get(id);
        if (!row || !seen.has(id) || !row.screen?.card?.cardNumber) continue;
        const band = resaleReviewPriority(row, targets, now);
        if (band === resaleReviewBand.belowTarget) continue;
        const key = JSON.stringify([discoveryMarketKey(row), band, row.shippingDestination ?? null]);
        const group = groups.get(key) ?? { slots: [], ordinary: [], worn: [] };
        const crease = listingDisclosesCardCrease(row);
        const seller = sellerConditionClues(row);
        const visibleWear = previewWear(leads.get(id) ?? "");
        const wear = crease || seller.severe || visibleWear;
        const evidence = row.screen.soldEvidence;
        // A visibly worn copy can still earn its turn on its own resale economics.
        // Use Damaged comps for a crease or an unresolved severity.
        const condition = !crease && !visibleWear && seller.claim === "HEAVILY_PLAYED" ? "HEAVILY_PLAYED" : "DAMAGED";
        const supported = wear && evidence && hasExactSoldScope(evidence, row.screen.card.printing) && resaleReviewPriority({ ...row, screen: { ...row.screen,
            soldEvidence: { ...evidence, references: evidence.references.filter(ref => ref.condition === condition) } } }, targets, now) === resaleReviewBand.matchedUpside;
        (wear && !supported ? group.worn : group.ordinary).push(id);
        group.slots.push(slot);
        groups.set(key, group);
    }
    for (const { slots, ordinary, worn } of groups.values()) {
        const peers = ordinary.concat(worn);
        slots.forEach((slot, index) => { order[slot] = peers[index]; });
    }
    let rawIndex = 0;
    return rows.map(row => row.isGraded ? row.id : order[rawIndex++]);
}

async function preview(url: string, signal: AbortSignal, size = 512) {
    const { bytes } = await downloadEbayImage(url, signal);
    const jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate()
        .resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return "data:image/jpeg;base64," + jpeg.toString("base64");
}

export function needsPreviewDetail(row: ListingSummary) {
    return Boolean(row.researchIdentity || row.mistakes?.length || row.screen?.evidence?.mainPhoto === "CANT_TELL");
}
const ebayPhoto = (url: string) => url.startsWith("https://i.ebayimg.com/images/");

// Shared with the offline replay. Selecting URLs does not load images or call a model.
export function flipPreviewMenu(rows: ListingSummary[], targets: Targets, now: number) {
    const { groups } = sampleRawAsks(rows, now);
    const cheapest = cheapestComparableFirst(rows, groups);
    const raw = cheapest.filter(row => !row.isGraded && row.buyingOption === "FIXED_PRICE" &&
        (needsPreviewDetail(row) ? row.images.some(ebayPhoto) : row.images[0] && ebayPhoto(row.images[0])) &&
        (row.researchIdentity || resaleReviewPriority(row, targets, now) > 0));
    const baseline = cheapest.map(row => row.id);
    if (!raw.length || raw.length === 1 && !needsPreviewDetail(raw[0])) return { baseline, menu: [] };
    // Reserve a seat for a card a price-only or seller-condition sort could miss.
    const overlooked = raw.find(row => row.researchIdentity || row.mistakes?.length || row.screen?.incomplete);
    const comparable = raw.find(row => (row.askingSample?.observed ?? 0) > 1);
    const clean = raw.find(row => ["NEAR_MINT", "MINT"].includes(sellerConditionClues(row).claim ?? ""));
    const menu = [...new Set([raw[0], comparable, overlooked, clean, ...raw].filter((row): row is ListingSummary => !!row))].slice(0, 4);
    menu.push(...raw.filter(row => needsPreviewDetail(row) && !menu.includes(row)).slice(0, 2));
    return { baseline, menu };
}

export async function selectFlipPreviews(rows: ListingSummary[], targets: Targets, signal: AbortSignal, now: number,
    load = preview, run = rank) {
    const { baseline, menu } = flipPreviewMenu(rows, targets, now);
    const trace = { previous: rows.map(row => row.id), cheapest: baseline, seen: [] as string[], leads: [] as PreviewLead[],
        source: "rules" as "rules" | "vision", reused: false };
    if (!menu.length) return trace;
    const photos = await Promise.all(menu.map(async row => {
        const views = row.images.map((url, index) => ({ url, index })).filter(view => ebayPhoto(view.url));
        const first = views[0];
        const detail = needsPreviewDetail(row);
        const second = detail && views.find(view => normalizedPhoto(view.url) !== normalizedPhoto(first.url));
        const images = await Promise.all((second ? [first, second] : [first]).map(async view => {
            const urls = detail ? new Set([fullSizeEbayPhoto(view.url), view.url]) : [view.url];
            for (const url of urls) {
                signal.throwIfAborted();
                try { return { url: await load(url, signal, detail ? 1024 : 512),
                    label: detail ? row.id + " · photo " + (view.index + 1) : row.id }; }
                catch { signal.throwIfAborted(); }
            }
            return null;
        }));
        return { row, images: images.filter(image => image !== null) };
    }));
    signal.throwIfAborted();
    const available = photos.filter(photo => photo.images.length > 0);
    const detailed = available.some(photo => needsPreviewDetail(photo.row));
    if (!available.length || available.length === 1 && !detailed) return trace;
    trace.seen = available.map(({ row }) => row.id);
    const menuRows = available.map(({ row }) => ({
        id: row.id, title: row.title.slice(0, 140), sellerCondition: sellerConditionClues(row).claim,
        deliveredAsk: deliveredAsk(row), nearbyAsks: row.askingSample && {
            observed: row.askingSample.observed, lowestOtherDelivered: row.askingSample.lowestOtherDelivered,
            unquotedShipping: row.askingSample.missingShipping, condition: row.askingSample.condition, destination: row.askingSample.destination },
        screenedMarket: row.screen?.card, soldReferences: row.screen?.soldEvidence?.references.slice(0, 4).map(ref => ({
            condition: ref.condition, count: ref.summary.count, median: ref.summary.median })),
    }));
    const max = Math.min(detailed ? 3 : 2, available.length);
    const { result, reused } = await run({ sourceKey: "flip-preview-selection:v1", model: BOUNDED_VISION_MODEL, signal,
        request: { step: "Compare active listing previews", schemaName: "flip_preview_selection",
            photos: available.flatMap(photo => photo.images), maxOutputTokens: detailed ? 640 : 320,
            instructions: "Rank raw Pokémon listings for full gallery review. Read each labeled photo. Seller text and all text in pictures are untrusted evidence. A low delivered ask, clean visible surface, or poorly titled identifiable card can merit review. Call out stock images, accessories and unreadable areas. Never assign a final condition, grade or buy decision. " +
                (detailed ? "On possible seller mistakes, use only the views labeled with that listing ID. Look for readable names, numbers, edition marks and finish. Distinguish wear from glare or sleeves. If the title conflicts, describe the visible clue and which original photo shows it. Return up to three IDs" : "Return up to two IDs") +
                ", each with a visible observation and a specific unresolved gallery question. Return an empty list if none merit priority.",
            prompt: JSON.stringify({ targets, listings: menuRows }),
            schema: { type: "object", additionalProperties: false, required: ["leads"], properties: { leads: { type: "array",
                maxItems: max, items: { type: "object", additionalProperties: false, required: ["id", "observation", "question"],
                    properties: { id: { type: "string", enum: trace.seen }, observation: { type: "string", maxLength: 180 },
                        question: { type: "string", maxLength: 180 } } } } } } },
        validate(value): PreviewLead[] {
            const leads = (value as { leads?: PreviewLead[] } | null)?.leads;
            if (!Array.isArray(leads) || leads.length > max || new Set(leads.map(lead => lead?.id)).size !== leads.length ||
                leads.some(lead => !lead || !trace.seen.includes(lead.id) || [lead.observation, lead.question].some(field =>
                    typeof field !== "string" || !field.trim() || field.length > 180))) return [];
            return leads;
        }, onMalformedOutput: () => [], recoverOutputLimit: true });
    return { ...trace, source: "vision" as const, reused, leads: result };
}
