import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedText } from "../../server/lib/http.ts";

test("bounded text reads decode UTF-8 across chunk boundaries and accept the exact byte limit", async () => {
    const bytes = new TextEncoder().encode("Pokémon");
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
    } });
    assert.equal(await readBoundedText(new Response(body), bytes.length), "Pokémon");
});

test("oversized chunked responses are cancelled without trusting Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(9)); },
        cancel() { cancelled = true; },
    });
    await assert.rejects(readBoundedText(new Response(body, { headers: { "Content-Length": "1" } }), 8), /exceeded/);
    assert.equal(cancelled, true);
});

test("an empty successful body is readable but an absent body is rejected", async () => {
    assert.equal(await readBoundedText(new Response(""), 8), "");
    await assert.rejects(readBoundedText(new Response(null, { status: 204 }), 8), /no response body/);
});
