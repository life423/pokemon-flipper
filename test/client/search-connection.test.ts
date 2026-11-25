import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError, streamDeals, type DealsMessage } from "../../client/src/api.ts";

test("a dropped response stream retains delivered rows and exposes explicit saved-batch recovery without an automatic new search", async t => {
    let calls = 0, part = 0;
    const messages: DealsMessage[] = [];
    const encoder = new TextEncoder();
    t.mock.method(globalThis, "fetch", async () => {
        calls++;
        return new Response(new ReadableStream({ pull(controller) {
            if (part++ === 0) controller.enqueue(encoder.encode(JSON.stringify({ type: "listing", listing: { id: "saved-copy" } }) + "\n"));
            else controller.error(new TypeError("network error"));
        } }));
    });
    await assert.rejects(streamDeals("Aquapolis", { minPrice: 0, searchRunId: "c8ad4909-33db-4bf0-acbf-047a41a6e44f" }, message => messages.push(message)), error => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, "SEARCH_STREAM_INTERRUPTED");
        assert.equal(error.retryable, true);
        assert.match(error.message, /Continue the search to check the remaining listings/);
        return true;
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "listing");
    assert.equal(calls, 1, "the stream reader cannot silently repeat a paid search");
});

test("an in-stream daily reserve stop retains its typed shared authority", async t => {
    const encoder = new TextEncoder();
    t.mock.method(globalThis, "fetch", async () => new Response(encoder.encode(JSON.stringify({
        type: "error", code: "EBAY_DAILY_BUDGET", retryable: false, scope: "search", error: "Daily reserve protected.",
    }) + "\n")));
    await assert.rejects(streamDeals("Aquapolis", { minPrice: 0 }, () => assert.fail("no listing was emitted")), error => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.code, "EBAY_DAILY_BUDGET");
        assert.equal(error.retryable, false);
        assert.equal(error.failureScope, "search");
        return true;
    });
});
