import { test } from "node:test";
import assert from "node:assert/strict";
import { runStructured } from "../../server/ai/openai.ts";
import { canRetryImageDownload, inlineEbayImage } from "../../server/ai/image-fallback.ts";

test("a provider image-download failure gets exactly one inline retry with the same structured task", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    const bodies: any[] = []; let downloads = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith("https://i.ebayimg.com/images/")) { downloads++; assert.equal(init?.redirect, "error"); return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }); }
        assert.equal(String(url), "https://api.openai.com/v1/responses");
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (bodies.length === 1) return Response.json({ error: { message: "Unable to download content from the provided URL before the timeout.", type: "invalid_request_error" } }, { status: 400 });
        return Response.json({ id: "offline-response", status: "completed", output_text: '{"ok":true}', output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } });
    });
    const result = await runStructured<{ ok: boolean }>({ step: "Offline image fallback", prompt: "Offline task", schemaName: "test_image", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, photos: [{ url: "https://i.ebayimg.com/images/g/offline/s-l1600.jpg" }] });
    assert.equal(result.result.ok, true); assert.equal(bodies.length, 2); assert.equal(downloads, 1);
    assert.match(bodies[1].input[0].content.find((part: any) => part.type === "input_image").image_url, /^data:image\/jpeg;base64,/);
    assert.deepEqual(bodies[1].text, bodies[0].text);
});

test("fallback rejects arbitrary hosts, redirects, invalid content and non-image API errors", async t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("html", { headers: { "content-type": "text/html" } }); });
    for (const url of ["http://i.ebayimg.com/images/a", "https://i.ebayimg.com.evil.test/images/a", "https://localhost/images/a", "https://i.ebayimg.com/private", "https://user@i.ebayimg.com/images/a"]) await assert.rejects(inlineEbayImage(url, new AbortController().signal), /Only public eBay/);
    assert.equal(requests, 0);
    await assert.rejects(inlineEbayImage("https://i.ebayimg.com/images/a", new AbortController().signal), /could not be retrieved/);
    assert.equal(canRetryImageDownload({ status: 401, message: "Unable to download" }), false);
    assert.equal(canRetryImageDownload({ status: 400, message: "Invalid schema" }), false);
});
