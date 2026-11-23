import "../fixtures/mock-ai-spending.ts";
import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { inlineEbayImage } from "../../server/ai/image-input.ts";

test("AI image input rejects arbitrary hosts and invalid content without following redirects", async t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        requests++;
        assert.equal(init?.redirect, "error");
        return new Response("html", { headers: { "content-type": "text/html" } });
    });
    for (const url of ["http://i.ebayimg.com/images/a", "https://i.ebayimg.com.evil.test/images/a", "https://localhost/images/a", "https://i.ebayimg.com/private", "https://user@i.ebayimg.com/images/a"]) await assert.rejects(inlineEbayImage(url, new AbortController().signal), /Only public eBay/);
    assert.equal(requests, 0);
    await assert.rejects(inlineEbayImage("https://i.ebayimg.com/images/a", new AbortController().signal), /could not be retrieved/);
});
