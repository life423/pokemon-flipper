import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("detail view leads with eBay access and an open original-photo viewer before long analysis", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { DetailPanel } = await vite.ssrLoadModule("/src/components/DetailPanel.tsx");
    const { PhotoGallery } = await vite.ssrLoadModule("/src/components/PhotoGallery.tsx");
    const first = "https://i.ebayimg.com/images/g/front/s-l225.jpg", back = "https://i.ebayimg.com/images/g/back/s-l1600.jpg";
    const value = cardEvaluation(); value.listing.photos = [first, back];
    const listing = { ...value.listing, currentPrice: value.listing.price, images: [first, back], url: "https://www.ebay.com/itm/123456789012", isGraded: false };
    const markup = renderToStaticMarkup(createElement(DetailPanel, { listing, analysis: { status: "done", evaluation: value },
        now: Date.now(), onClose: () => {}, onAnalyze: () => { assert.fail("rendering must never analyze"); }, onPhotoReview: () => {}, onSave: () => {} }));
    const ebay = markup.indexOf("Open on eBay");
    const photos = markup.indexOf('aria-label="Listing photos"');
    assert.ok(ebay > 0 && ebay < photos);
    assert.ok(photos < markup.indexOf("Auction decision"));
    assert.match(markup, /href="https:\/\/www\.ebay\.com\/itm\/123456789012" target="_blank" rel="noopener noreferrer"/);
    assert.match(markup, /src="https:\/\/i\.ebayimg\.com\/images\/g\/front\/s-l1600\.jpg"/);
    assert.match(markup, /href="https:\/\/i\.ebayimg\.com\/images\/g\/front\/s-l225\.jpg" target="_blank"/);
    assert.match(markup, /aria-label="Zoomable listing photo"/);
    assert.match(markup, /aria-label="Photo zoom"/);
    assert.match(markup, /max="16"/);
    assert.match(markup, /aria-label="Previous photo"/); assert.match(markup, /aria-label="Next photo"/);
    assert.ok(markup.indexOf('aria-label="Next photo"') < markup.indexOf('aria-label="Zoomable listing photo"'), "navigation stays above the large image");
    assert.ok(markup.indexOf('aria-label="Choose a listing photo"') < markup.indexOf('aria-label="Zoomable listing photo"'), "thumbnails are already visible above the large image");
    assert.match(markup, /aria-label="Show photo 1" aria-pressed="true"/);
    assert.match(markup, /aria-label="Show photo 2" aria-pressed="false"/);
    assert.doesNotMatch(markup, /<summary>Choose a photo/);
    assert.match(markup, /Loading photo 1/);
    assert.match(markup, /Reset view/); assert.match(markup, /cannot recover missing detail/);
    assert.ok(markup.indexOf('aria-label="Zoomable listing photo"') < markup.indexOf("<details"), "the main photo is visible without opening a disclosure");
    const inconclusive = renderToStaticMarkup(createElement(DetailPanel, { listing, analysis: { status: "inconclusive", message: "Conflicting readings for photo 2." },
        now: Date.now(), onClose() {}, onAnalyze() { assert.fail("saved conflicts must not repeat analysis"); }, onPhotoReview() {} }));
    assert.match(inconclusive, /Photo check inconclusive/);
    assert.match(inconclusive, /Conflicting readings for photo 2/);
    assert.match(inconclusive, /aria-label="Listing photos"/);
    assert.doesNotMatch(inconclusive, /Try again|analysis failed|Estimated grade|Analyze listing \(paid\)/i);
    const held = renderToStaticMarkup(createElement(DetailPanel, { listing, analysis: { status: "held", message: "An earlier request is unresolved for this photo." },
        now: Date.now(), onClose() {}, onAnalyze() { assert.fail("held evidence must not be reanalyzed"); } }));
    assert.match(held, /Previous AI check unresolved/);
    assert.match(held, /An earlier request is unresolved for this photo/);
    assert.doesNotMatch(held, /Try again|Analyze listing \(paid\)|Photo check inconclusive/);
    const empty = renderToStaticMarkup(createElement(PhotoGallery, { images: [] }));
    assert.match(empty, /No listing photos available/); assert.doesNotMatch(empty, /<img/);
    const single = renderToStaticMarkup(createElement(PhotoGallery, { images: [first, first] }));
    assert.match(single, /Photo 1 of 1/);
    assert.match(single, /disabled="" aria-label="Previous photo"/);
    assert.doesNotMatch(single, /Choose a photo/);

    const docked = renderToStaticMarkup(createElement(DetailPanel, { docked: true, listing,
        analysis: { status: "done", evaluation: value }, now: Date.now(),
        onClose() {}, onAnalyze() { assert.fail("opening saved analysis cannot purchase research"); }, onPhotoReview() {} }));
    assert.match(docked, /data-docked="true" aria-label="Listing analysis" role="region"/);
    assert.doesNotMatch(docked, /aria-modal|role="dialog"|backdrop/);
    assert.match(markup, /role="dialog" aria-modal="true"/, "compact screens retain modal semantics");
    assert.match(docked, /Open on eBay/);
    assert.match(docked, /aria-label="Zoomable listing photo"/);
});
