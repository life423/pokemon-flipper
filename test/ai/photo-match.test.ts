import { test } from "node:test";
import assert from "node:assert/strict";
import { createMainPhotoMatcher, type ClaimedCard, type PhotoMatch } from "../../server/ai/photo-match.ts";
import { screeningSteps } from "../../server/deals/screen-listing.ts";
import { MODEL } from "../../server/ai/openai.ts";

const thumbnail = "https://i.ebayimg.com/images/g/offline/s-l225.jpg";
const fullSize = "https://i.ebayimg.com/images/g/offline/s-l1600.jpg";
const card: ClaimedCard = { name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", printingLabel: "Unlimited" };
const reading: PhotoMatch = { verdict: "MATCH", problems: [], firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function memoryCache(initial: [string, PhotoMatch][] = []) {
    const saved = new Map(initial);
    return {
        saved,
        load: async (key: string) => saved.get(key) ?? null,
        save: async (key: string, value: unknown) => { saved.set(key, value as PhotoMatch); },
    };
}

test("resized aliases share one paid main-photo reading and its saved result", async () => {
    const cache = memoryCache();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const match = createMainPhotoMatcher({ ...cache, read: async (url) => {
        calls++;
        assert.equal(url, fullSize);
        started.resolve();
        await release.promise;
        return reading;
    } });

    const first = match(thumbnail, card);
    await started.promise;
    const second = match(fullSize, card);
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [reading, reading]);
    assert.equal(await match(fullSize.replace("1600", "500"), card), reading);
    assert.equal(calls, 1);
    assert.equal(cache.saved.size, 1);
    assert.match([...cache.saved.keys()][0], /s-l1600\.jpg/);
});

test("previous thumbnail and caller-sized cache keys migrate without another paid reading", async () => {
    for (const [previousUrl, requestedUrl] of [[thumbnail, fullSize], [thumbnail.replace("225", "500"), thumbnail.replace("225", "500")]]) {
        const previousKey = `photo-match:v2:${MODEL}:${previousUrl}:base set|4/102|charizard`;
        const cache = memoryCache([[previousKey, reading]]);
        let calls = 0;
        const match = createMainPhotoMatcher({ ...cache, read: async () => { calls++; return reading; } });

        assert.equal(await match(requestedUrl, card), reading);
        assert.equal(calls, 0);
        assert.equal(cache.saved.get(`photo-match:v2:${MODEL}:${fullSize}:base set|4/102|charizard`), reading);
    }
});

test("a canceled main-photo check waiting for a slot never dispatches", async () => {
    const cache = memoryCache();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const match = createMainPhotoMatcher({ ...cache, concurrency: 1, read: async () => {
        calls++;
        started.resolve();
        await release.promise;
        return reading;
    } });

    const active = match(thumbnail, card);
    await started.promise;
    const stop = new AbortController();
    const queued = match(thumbnail.replace("offline", "queued"), card, stop.signal);
    const rejected = assert.rejects(queued, { name: "AbortError" });
    await tick();
    stop.abort();
    await rejected;
    release.resolve();
    assert.equal(await active, reading);
    await tick();
    assert.equal(calls, 1);
    assert.equal(cache.saved.size, 1);
});

test("one canceled search does not cancel a shared photo needed by another search", async () => {
    const cache = memoryCache();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const match = createMainPhotoMatcher({ ...cache, read: async (_url, _card, dispatchSignal) => {
        calls++;
        started.resolve(dispatchSignal);
        await release.promise;
        return reading;
    } });
    const stop = new AbortController();
    const first = match(thumbnail, card, stop.signal);
    const rejected = assert.rejects(first, { name: "AbortError" });
    const dispatchSignal = await started.promise;
    const second = match(fullSize, card, new AbortController().signal);
    stop.abort();
    await rejected;
    assert.equal(dispatchSignal.aborted, false);
    release.resolve();
    assert.equal(await second, reading);
    assert.equal(calls, 1);
});

test("a new search waits for a canceled search's dispatched photo to save before checking again", async () => {
    const cache = memoryCache();
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const match = createMainPhotoMatcher({ ...cache, read: async (_url, _card, dispatchSignal) => {
        calls++;
        started.resolve(dispatchSignal);
        await release.promise;
        return reading;
    } });
    const stop = new AbortController();
    const first = match(thumbnail, card, stop.signal);
    const rejected = assert.rejects(first, { name: "AbortError" });
    const dispatchSignal = await started.promise;
    stop.abort();
    await rejected;
    assert.equal(dispatchSignal.aborted, true);
    const next = match(fullSize, card);
    await tick();
    assert.equal(calls, 1);
    release.resolve();
    assert.equal(await next, reading);
    assert.equal(calls, 1);
    assert.equal(cache.saved.size, 1);
});

test("screening passes its cancellation signal into main-photo checks", async () => {
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(screeningSteps(undefined, false, stop.signal).matchPhoto(thumbnail, card), { name: "AbortError" });
});
