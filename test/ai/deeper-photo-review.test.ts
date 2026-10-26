import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewPhotosDeeper } from "../../server/ai/deeper-photo-review.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const input = () => ({ title: "Offline seller claim", photos: [{ number: 4, view: "FRONT", url: "https://example.invalid/front.jpg" }], photoCheck: cardEvaluation().photoCheck!, condition: cardEvaluation().condition });
test("focused review uses bounded structured vision output and makes no automatic retry after a rate limit", async (t) => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "offline-test-key";
    t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
    let calls = 0; let fail = false;
    // The SDK captures this transport at client creation; switch its mocked
    // response rather than replacing the global transport after creation.
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        calls++;
        if (fail) return Response.json({ error: { message: "Offline rate limit", type: "rate_limit_error" } }, { status: 429 });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.text.format.type, "json_schema");
        assert.equal(body.text.format.name, "focused_photo_review");
        assert.equal(body.max_output_tokens, 8192);
        assert.equal(body.input[0].content.filter((part: { type: string }) => part.type === "input_image").length, 1);
        assert.match(body.input[0].content[0].text, /Do not assign a new numeric grade/);
        const answer = { summary: "Still uncertain.", findings: [{ area: "SURFACE", impact: "UNRESOLVED", observation: "Glare obscures detail.", photoNumbers: [1] }], requestedPhotos: [] };
        return Response.json({ id: "resp_offline", object: "response", status: "completed", output: [{ type: "message", id: "msg_offline", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 20 } });
    });
    const review = await reviewPhotosDeeper(input());
    assert.equal(review.result.summary, "Still uncertain.");
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(reviewPhotosDeeper(input()), /rate limited/);
    assert.equal(calls, 2, "rate limit consumes one attempted request, without a retry");
});
