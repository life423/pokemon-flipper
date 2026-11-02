import "../fixtures/isolated-data.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { aiInputHash, createAiInputPreflight, InputPreflightError, type AiInputProof } from "../../server/ai/input-preflight.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";

const image = "data:image/png;base64,aW1tdXRhYmxl";
const body = () => ({ model: "gpt-5.6-luna", service_tier: "default", prompt_cache_options: { mode: "explicit", ttl: "30m" }, max_output_tokens: 800,
    instructions: "Trusted photo instructions", metadata: { app_step: "Offline counting fixture" }, reasoning: { effort: "low" },
    input: [{ role: "user", content: [{ type: "input_text", text: "Quoted listing data" }, { type: "input_image", image_url: image, detail: "high" }] }],
    text: { format: { type: "json_schema", name: "offline", strict: true, schema: { type: "object", properties: { grade: { type: "integer" } }, required: ["grade"], additionalProperties: false } } } });
function fixture(t: TestContext, options: Parameters<typeof createAiInputPreflight>[0] = {}) {
    const previous = process.env.OPENAI_API_KEY;
    if (previous !== "offline-counting-secret") {
        process.env.OPENAI_API_KEY = "offline-counting-secret";
        t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    }
    const cache = new Map<string, AiInputProof>(), events: unknown[] = [];
    const requests: { url: string; init?: RequestInit }[] = [];
    const count = createAiInputPreflight({
        read: async key => cache.get(key) ?? null, write: async (key, proof) => { cache.set(key, proof); },
        ready: async () => {}, record: async event => { events.push(event); },
        fetch: async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ object: "response.input_tokens", input_tokens: 1234 }); },
        ...options,
    });
    return { count, cache, events, requests };
}

test("exact preflight projects every token-bearing generation field and never calls generation", async t => {
    const { count, requests, events } = fixture(t);
    const request = body();
    assert.deepEqual(await withAiUsageContext({ searchId: "offline-search", listingId: "offline-listing" }, () => count(request)), { inputHash: aiInputHash(request), inputTokens: 1234 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.openai.com/v1/responses/input_tokens");
    assert.equal(requests[0].init?.method, "POST"); assert.equal(requests[0].init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { model: request.model, input: request.input, instructions: request.instructions, reasoning: request.reasoning, text: request.text });
    assert.equal(events.length, 1);
    assert.equal((events[0] as any).searchId, "offline-search"); assert.equal((events[0] as any).listingId, "offline-listing");
    assert.doesNotMatch(JSON.stringify(events), /secret|Quoted listing|Trusted photo|data:image/);
});

test("identical concurrent counts coalesce and saved exact proofs survive subsequent consumers", async t => {
    const { count, requests } = fixture(t);
    const request = body();
    const proofs = await Promise.all([count(request), count(structuredClone(request)), count(request)]);
    assert.deepEqual(proofs[0], proofs[1]); assert.equal(requests.length, 1);
    assert.deepEqual(await count(request), proofs[0]); assert.equal(requests.length, 1);
    const changed = body(); changed.instructions += " Changed instructions";
    await count(changed); assert.equal(requests.length, 2, "different instructions cannot reuse the previous bound");
    changed.text.format.schema.properties.grade.type = "number";
    await count(changed); assert.equal(requests.length, 3, "schema changes require their own exact bound");
});

test("mutable images, files, tools, conversations and unsupported fields never reach counting", async t => {
    const { count, requests } = fixture(t);
    const base = body();
    const remote = structuredClone(base); remote.input[0].content[1].image_url = "https://i.ebayimg.com/images/mutable.jpg";
    for (const request of [remote, { ...base, conversation: "old-context" }, { ...base, tools: [{ type: "web_search" }] },
        { ...base, previous_response_id: "resp_old" }, { ...base, audio: {} }, { ...base, truncation: "auto" },
        { ...base, input: [{ type: "input_file", file_id: "file_old" }] }]) {
        await assert.rejects(count(request), InputPreflightError);
    }
    assert.equal(requests.length, 0);
});

test("unverified cache TTLs and overrides cannot reach counting while billing options remain hash-bound", async t => {
    const { count, requests } = fixture(t);
    const base = body();
    for (const request of [{ ...base, prompt_cache_options: { mode: "explicit", ttl: "12h" } },
        { ...base, prompt_cache_retention: "in_memory" }, { ...base, prompt_cache_options: { mode: "explicit", ttl: "30m", breakpoint: 1 } }]) {
        await assert.rejects(count(request), InputPreflightError);
    }
    assert.equal(requests.length, 0);
    const explicit = await count(base);
    const implicit = await count({ ...base, prompt_cache_options: { mode: "implicit", ttl: "30m" } });
    assert.notEqual(explicit.inputHash, implicit.inputHash);
    assert.equal(requests.length, 2);
    for (const request of requests) assert.equal(Object.hasOwn(JSON.parse(String(request.init?.body)), "prompt_cache_options"), false);
});

test("cache corruption, cache outages and final SQL readiness failures authorize zero count requests", async t => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => { requests++; throw new Error("No count request authorized"); };
    const corrupt = fixture(t, { fetch, read: async () => ({ inputHash: "unrelated", inputTokens: 1 }) });
    await assert.rejects(corrupt.count(body()), /saved exact AI token proof is invalid/);
    const unavailable = new StorageUnavailableError("Offline SQL unavailable");
    const cacheFailure = fixture(t, { fetch, read: async () => { throw unavailable; } });
    await assert.rejects(cacheFailure.count(body()), error => error === unavailable);
    const finalFailure = fixture(t, { fetch, ready: async () => { throw unavailable; } });
    await assert.rejects(finalFailure.count(body()), error => error === unavailable);
    assert.equal(requests, 0);
});

test("counting API errors and malformed answers are not retried and do not expose provider bodies", async t => {
    for (const response of [new Response("private-provider-body", { status: 500 }), new Response("private-provider-body", { status: 200 }), Response.json({ object: "response.input_tokens", input_tokens: -1 }), Response.json({ input_tokens: 2 })]) {
        let calls = 0;
        const { count, cache } = fixture(t, { fetch: async () => { calls++; return response; } });
        await assert.rejects(count(body()), error => error instanceof InputPreflightError && !error.message.includes("private-provider-body"));
        assert.equal(calls, 1); assert.equal(cache.size, 0);
    }
});

test("network or count-checkpoint failures remain controlled non-generating stops", async t => {
    let calls = 0;
    const network = fixture(t, { fetch: async () => { calls++; throw new Error("private network failure details"); } });
    await assert.rejects(network.count(body()), error => error instanceof InputPreflightError && !error.message.includes("private network"));
    assert.equal(calls, 1);
    const checkpoint = fixture(t, { write: async () => { throw new Error("private disk error"); } });
    await assert.rejects(checkpoint.count(body()), StorageUnavailableError);
    const audit = fixture(t, { record: async () => { throw new Error("private audit error"); } });
    await assert.rejects(audit.count(body()), StorageUnavailableError);
});

test("a consumer may stop while another retains the same useful token count", async t => {
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const first = new AbortController(); let current: AbortSignal | undefined = first.signal, calls = 0;
    const { count } = fixture(t, { signal: () => current, fetch: async () => { calls++; await ready; return Response.json({ object: "response.input_tokens", input_tokens: 45 }); } });
    const stopped = count(body()); current = undefined; const live = count(body());
    await new Promise<void>(resolve => setImmediate(resolve));
    first.abort(); await assert.rejects(stopped, { name: "AbortError" });
    finish(); assert.equal((await live).inputTokens, 45); assert.equal(calls, 1);
});

test("pause or request mutation during counting prevents use of the result", async t => {
    let allowed = true;
    const paused = fixture(t, { checkAllowed: async () => { if (!allowed) throw new InputPreflightError("Offline pause"); },
        fetch: async () => { allowed = false; return Response.json({ object: "response.input_tokens", input_tokens: 34 }); } });
    await assert.rejects(paused.count(body()), /Offline pause/);
    const request = body();
    const changed = fixture(t, { fetch: async () => { request.instructions += " mutation"; return Response.json({ object: "response.input_tokens", input_tokens: 34 }); } });
    await assert.rejects(changed.count(request), /request changed/);
});
