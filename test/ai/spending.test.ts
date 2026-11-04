import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { aiInputHash, aiSpending, aiSpendingFailure, AiSpendingError, createAiSpendingGuard } from "../../server/ai/spending.ts";
import { withAiDispatchSignal, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { evaluationFailure } from "../../server/analysis/failure.ts";
import { searchFailureMessage } from "../../server/deals/errors.ts";
import { runStructured } from "../../server/ai/openai.ts";

const body = { model: "gpt-5.6-luna", service_tier: "default", prompt_cache_options: { mode: "explicit", ttl: "30m" }, max_output_tokens: 100,
    input: [{ role: "user", content: [{ type: "input_text", text: "Offline bounded fixture" }] }] };
const proof = async (request: unknown) => ({ inputHash: aiInputHash(request), inputTokens: 100 });
const book = async (directory: string) => JSON.parse(await fs.readFile(path.join(directory, "ai-spending-ledger.json"), "utf8"));
async function fixture(cap = 0.001) {
    const directory = await fs.mkdtemp(path.join(isolatedDataDir, "budget-"));
    const guard = createAiSpendingGuard({ directory, preflight: proof });
    await guard.configure({ paused: false, perSearchCapUsd: cap });
    return { directory, guard, context: { searchId: randomUUID() } };
}
const denied = (code: string) => (error: unknown) => error instanceof AiSpendingError && error.code === code;

test("persistent pause survives a new guard and denies before preflight or any transport work", async () => {
    const { directory, guard, context } = await fixture();
    await guard.configure({ paused: true, perSearchCapUsd: null, pauseReason: "Offline audit pause" });
    let preflights = 0;
    const restarted = createAiSpendingGuard({ directory, preflight: async request => { preflights++; return proof(request); } });
    await assert.rejects(restarted.reserve(body, context), denied("AI_PAUSED"));
    assert.equal(preflights, 0); assert.equal((await restarted.status()).paused, true);
    assert.deepEqual((await book(directory)).searches, {});
});

test("concurrent reservations and restart cannot overcommit a single search cap", async () => {
    const { directory, guard, context } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => guard.reserve(body, context)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 6);
    assert.ok(results.filter(result => result.status === "rejected").every(result => aiSpendingFailure(result.reason)?.code === "AI_BUDGET"));
    const account = (await book(directory)).searches[context.searchId];
    assert.equal(account.heldNanoUsd, 870000); assert.equal(account.capNanoUsd, 1000000); assert.equal(account.attempts.length, 6);
    const restarted = createAiSpendingGuard({ directory, preflight: proof });
    await assert.rejects(restarted.reserve(body, context), denied("AI_BUDGET"));
    assert.equal((await book(directory)).searches[context.searchId].heldNanoUsd, 870000, "restart cannot refund pending/uncertain billed work");
});

test("unknown billing retains its hold; complete known usage reconciles once without losing restart safety", async () => {
    const { directory, guard, context } = await fixture(0.0002);
    const reservation = await guard.reserve(body, context);
    await guard.settle(reservation, { usage: { input_tokens: 1, output_tokens: 1 } });
    await assert.rejects(guard.reserve(body, context), denied("AI_BUDGET"));
    const reported = { model: body.model, service_tier: "default", usage: { input_tokens: 80, output_tokens: 20,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10, cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 0 } } } };
    await guard.settle(reservation, reported); await guard.settle(reservation, reported);
    assert.equal((await book(directory)).searches[context.searchId].heldNanoUsd, 36900);
    assert.ok(await guard.reserve(body, context));
    assert.equal((await book(directory)).searches[context.searchId].heldNanoUsd, 181900);
});

test("the verified newer Luna rates preserve mixed-model reservations and historical holds across restart", async () => {
    const { directory, guard, context } = await fixture(0.02);
    await guard.reserve(body, context);
    const request = { ...body, model: "gpt-6-luna" };
    assert.notEqual(aiInputHash(request), aiInputHash(body), "a token proof for another model cannot establish the new request's input");
    const restarted = createAiSpendingGuard({ directory, preflight: proof });
    const reservation = await restarted.reserve(request, context);
    const before = (await book(directory)).searches[context.searchId];
    assert.deepEqual(before.attempts.map((attempt: { model: string; reservedNanoUsd: number }) => [attempt.model, attempt.reservedNanoUsd]),
        [["gpt-5.6-luna", 145000], ["gpt-6-luna", 62500]]);
    assert.equal(before.heldNanoUsd, 207500);
    await restarted.settle(reservation, { model: request.model, service_tier: "default", usage: { input_tokens: 80, output_tokens: 20 } });
    assert.equal((await restarted.summary(context.searchId)).heldUsd, 0.0002075, "unknown cache billing retains the entire reservation");
    await restarted.settle(reservation, { model: request.model, service_tier: "default", usage: { input_tokens: 80, output_tokens: 20,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10, cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 0 } } } });
    const again = createAiSpendingGuard({ directory, preflight: proof });
    const after = await again.summary(context.searchId);
    assert.equal(after.capUsd, 0.02); assert.equal(after.heldUsd, 0.000145); assert.equal(after.settledUsd, 0.00001645);
    assert.equal(after.committedUsd, 0.00016145); assert.equal(after.unsettledAttempts, 1);
    assert.equal((await book(directory)).searches[context.searchId].attempts[0].state, "RESERVED", "adding model support cannot refund historical work");
});

test("newer Luna support retains the exact model, tier and two-cent input/output boundaries", async () => {
    const { directory, guard, context } = await fixture(0.02);
    const request = { ...body, model: "gpt-6-luna" };
    for (const invalid of [{ ...request, model: "gpt-6-luna-preview" }, { ...request, service_tier: "priority" },
        { ...request, prompt_cache_options: { mode: "explicit", ttl: "12h" } }]) {
        await assert.rejects(guard.reserve(invalid, context), denied("AI_BUDGET"));
    }
    await assert.rejects(guard.reserve({ ...request, max_output_tokens: 40000 }, context), /would exceed the search's remaining AI budget/,
        "the maximum output plus exact input must fit, even when output alone equals two cents");
    const longInput = createAiSpendingGuard({ directory, preflight: async value => ({ inputHash: aiInputHash(value), inputTokens: 272001 }) });
    await assert.rejects(longInput.reserve(request, context), /standard-context price boundary/);
    assert.deepEqual((await book(directory)).searches, {});
});

test("unattributed, unknown model/tier/cache, tool charges and unproven inputs fail closed", async () => {
    const { directory, guard, context } = await fixture(0.02);
    const unknownInputs = createAiSpendingGuard({ directory });
    await assert.rejects(unknownInputs.reserve(body, context), /exact input-token preflight/);
    await assert.rejects(guard.reserve(body, {}), /valid search ID/);
    for (const request of [{ ...body, model: "unknown" }, { ...body, service_tier: "priority" }, { ...body, prompt_cache_retention: "12h" },
        { ...body, max_output_tokens: undefined }, { ...body, tools: [{ type: "web_search" }] }, { ...body, previous_response_id: "resp_old" }]) {
        await assert.rejects(guard.reserve(request, context), denied("AI_BUDGET"));
    }
    const wrongProof = createAiSpendingGuard({ directory, preflight: async () => ({ inputHash: "unrelated request", inputTokens: 1 }) });
    await assert.rejects(wrongProof.reserve(body, context), /does not match/);
    assert.deepEqual((await book(directory)).searches, {});
    await fs.unlink(path.join(directory, "ai-spending.json"));
    await assert.rejects(guard.reserve(body, context), /initialized AI spending control is missing/);
});

test("only verified 30-minute cache policies are admitted without retention or breakpoint overrides", async () => {
    const { directory, guard, context } = await fixture(0.02);
    for (const request of [
        { ...body, prompt_cache_options: { mode: "explicit", ttl: "12h" } },
        { ...body, prompt_cache_options: { mode: "unknown", ttl: "30m" } },
        { ...body, prompt_cache_options: { mode: "explicit", ttl: "30m", breakpoints: [0] } },
        { ...body, prompt_cache_options: { mode: "implicit", ttl: "30m", extra: true } },
        { ...body, prompt_cache_options: undefined, prompt_cache_retention: "in_memory" },
        { ...body, prompt_cache_retention: "24h" },
        { ...body, input: [{ role: "user", content: [{ type: "input_text", text: "Offline", cache_control: { ttl: "12h" } }] }] },
        { ...body, input: [{ role: "user", content: "Offline", cache_control: { ttl: "12h" } }] },
    ]) await assert.rejects(guard.reserve(request, context), denied("AI_BUDGET"));
    assert.deepEqual((await book(directory)).searches, {});
    assert.ok(await guard.reserve({ ...body, prompt_cache_options: { mode: "implicit", ttl: "30m" } }, context));
});

test("unexpected usage automatically pauses later dispatch and preserves the discrepancy", async () => {
    const { directory, guard, context } = await fixture(0.02);
    const reservation = await guard.reserve(body, context);
    await guard.settle(reservation, { model: body.model, service_tier: "default", usage: { input_tokens: 101, output_tokens: 100,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    assert.equal((await guard.status()).paused, true);
    await assert.rejects(guard.reserve(body, context), denied("AI_PAUSED"));
    assert.ok((await book(directory)).searches[context.searchId].heldNanoUsd >= 145000);
});

test("independent processes share the same durable reservation limit", async () => {
    const { directory, context } = await fixture();
    const moduleUrl = new URL("../../server/ai/spending.ts", import.meta.url).href;
    const source = `import {createAiSpendingGuard,aiInputHash} from ${JSON.stringify(moduleUrl)};
        const guard=createAiSpendingGuard({directory:process.env.POKEMON_FLIPPER_DATA_DIR,preflight:async body=>({inputHash:aiInputHash(body),inputTokens:100})});
        let allowed=0;for(let n=0;n<8;n++){try{await guard.reserve(${JSON.stringify(body)},${JSON.stringify(context)});allowed++;}catch(error){if(error.code!=='AI_BUDGET')throw error;}}
        console.log(JSON.stringify({allowed}));`;
    const child = () => new Promise<number>((resolve, reject) => {
        const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
            cwd: path.resolve(import.meta.dirname, "../.."), env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "", errors = "";
        processChild.stdout.on("data", part => { output += part; }); processChild.stderr.on("data", part => { errors += part; });
        processChild.on("error", reject); processChild.on("exit", code => code === 0 ? resolve(JSON.parse(output).allowed) : reject(new Error(errors)));
    });
    const allowed = await Promise.all([child(), child(), child()]);
    assert.equal(allowed.reduce((sum, count) => sum + count, 0), 6);
    assert.equal((await book(directory)).searches[context.searchId].heldNanoUsd, 870000);
});

test("the real SDK sends zero requests when persistent pause/budget blocks, without connection retries", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-budget-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    let network = 0, reservations = 0;
    t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("No network is allowed in this test"); });
    const original = aiSpending.reserve;
    t.mock.method(aiSpending, "reserve", async (...args) => { reservations++; return original(...args); });
    await aiSpending.configure({ paused: true, perSearchCapUsd: null });
    const request = () => runStructured({ step: "Offline spending guard fixture", schemaName: "search_intent", prompt: "Offline fixture", photos: [], schema: { type: "object", properties: {}, additionalProperties: false } });
    await assert.rejects(request(), denied("AI_PAUSED")); assert.equal(reservations, 1); assert.equal(network, 0);
    await aiSpending.configure({ paused: false, perSearchCapUsd: 0 });
    await assert.rejects(withAiUsageContext({ searchId: randomUUID() }, request), denied("AI_BUDGET"));
    assert.equal(reservations, 2, "a local denial must not trigger SDK/application connection retries"); assert.equal(network, 0);
    const wrapped = new Error("SDK connection error", { cause: new AiSpendingError("AI_BUDGET", "Offline capped search") });
    assert.equal(evaluationFailure(wrapped).code, "AI_BUDGET"); assert.equal(evaluationFailure(wrapped).retryable, false);
    assert.equal(searchFailureMessage(wrapped), "Offline capped search");
});


test("the confirmed two-cent cap rejects current full-photo output before any preflight", async () => {
    const { directory, context } = await fixture(0.02); let counts = 0;
    const guard = createAiSpendingGuard({ directory, preflight: async request => { counts++; return proof(request); } });
    await assert.rejects(guard.reserve({ ...body, model: "gpt-5.6-terra", max_output_tokens: 16384 }, context), /maximum output alone exceeds/);
    assert.equal(counts, 0); assert.deepEqual((await book(directory)).searches, {});
    await assert.rejects(guard.reserve({ ...body, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://mutable.example.invalid/photo" }] }] }, context), /mutable image URLs/);
    assert.equal(counts, 0);
});

test("corrupt and missing initialized ledgers are retained and never recreated to release spend", async () => {
    const { directory, guard, context } = await fixture();
    const file = path.join(directory, "ai-spending-ledger.json");
    await fs.writeFile(file, "corrupt ledger");
    await assert.rejects(guard.reserve(body, context), denied("AI_BUDGET"));
    assert.equal(await fs.readFile(file, "utf8"), "corrupt ledger");
    await fs.unlink(file);
    await assert.rejects(guard.reserve(body, context), /missing or invalid/);
    await assert.rejects(guard.configure({ paused: false, perSearchCapUsd: 0.02 }), /missing or invalid/);
    await assert.rejects(fs.access(file));
});


test("a fresh data directory is paused and cannot make even one unconfigured paid dispatch", async t => {
    const directory = await fs.mkdtemp(path.join(isolatedDataDir, "fresh-install-"));
    const guard = createAiSpendingGuard({ directory });
    const status = await guard.status();
    assert.equal(status.enabled, true); assert.equal(status.paused, true); assert.equal(status.configured, false); assert.equal(status.perSearchCapUsd, 0.02);
    let dispatches = 0;
    t.mock.method(globalThis, "fetch", async () => { dispatches++; throw new Error("Fresh install must never dispatch"); });
    // Exercise the real default SDK transport against a directory whose entire
    // control/ledger state is missing, as on a new checkout or deleted folder.
    const controlPath = path.join(isolatedDataDir, "ai-spending.json"), ledgerPath = path.join(isolatedDataDir, "ai-spending-ledger.json");
    await fs.rm(controlPath, { force: true }); await fs.rm(ledgerPath, { force: true });
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-fresh-install";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    await assert.rejects(runStructured({ step: "Fresh install guard fixture", schemaName: "search_intent", prompt: "Offline", photos: [], schema: { type: "object", properties: {}, additionalProperties: false } }), denied("AI_PAUSED"));
    assert.equal(dispatches, 0);
    await assert.rejects(guard.configure({ paused: false, perSearchCapUsd: 0.03 }), /between \$0 and \$0.02/);
});

test("remote preflight releases the file lock and a concurrent pause prevents reservation", async () => {
    const directory = await fs.mkdtemp(path.join(isolatedDataDir, "pause-count-"));
    const guard = createAiSpendingGuard({ directory, preflight: async request => {
        await guard.configure({ paused: true, perSearchCapUsd: 0.02, pauseReason: "Paused while counting" });
        return proof(request);
    } });
    await guard.configure({ paused: false, perSearchCapUsd: 0.02 });
    await assert.rejects(guard.reserve(body, { searchId: randomUUID() }), denied("AI_PAUSED"));
    assert.deepEqual((await book(directory)).searches, {});
});

test("a lower cap, changed request or cancellation during preflight cannot authorize dispatch", async () => {
    const directory = await fs.mkdtemp(path.join(isolatedDataDir, "change-count-"));
    let action: (request: unknown) => Promise<void> = async () => {};
    const stopped = new AbortController();
    const guard = createAiSpendingGuard({ directory, preflight: async request => { const original = await proof(request); await action(request); return original; } });
    await guard.configure({ paused: false, perSearchCapUsd: 0.02 });
    action = async () => { await guard.configure({ paused: false, perSearchCapUsd: 0.00001 }); };
    await assert.rejects(guard.reserve(body, { searchId: randomUUID() }), denied("AI_BUDGET"));
    await guard.configure({ paused: false, perSearchCapUsd: 0.02 });
    action = async request => { (request as any).instructions = "Changed immutable instructions"; };
    await assert.rejects(guard.reserve(structuredClone(body), { searchId: randomUUID() }), /does not match/);
    action = async () => { stopped.abort(); };
    await assert.rejects(withAiDispatchSignal(stopped.signal, () => guard.reserve(body, { searchId: randomUUID() })), { name: "AbortError" });
    assert.deepEqual((await book(directory)).searches, {});
});

test("the standard-context pricing threshold rejects oversized exact inputs before reservation", async () => {
    const { directory, context } = await fixture(0.02);
    const guard = createAiSpendingGuard({ directory, preflight: async request => ({ inputHash: aiInputHash(request), inputTokens: 272001 }) });
    await assert.rejects(guard.reserve(body, context), /standard-context price boundary/);
    assert.deepEqual((await book(directory)).searches, {});
});

test("search summaries distinguish reported settled cost from conservative unresolved holds", async () => {
    const { directory, guard, context } = await fixture();
    const initial = await guard.summary(context.searchId);
    assert.equal(initial.capUsd, 0.001); assert.equal(initial.remainingUsd, 0.001); assert.equal(initial.committedUsd, 0);
    const reservation = await guard.reserve(body, context);
    const held = await guard.summary(context.searchId);
    assert.equal(held.committedUsd, 0.000145); assert.equal(held.heldUsd, 0.000145); assert.equal(held.settledUsd, 0); assert.equal(held.unsettledAttempts, 1);
    await guard.settle(reservation, { model: body.model, service_tier: "default", usage: { input_tokens: 80, output_tokens: 20,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10, cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 0 } } } });
    const settled = await guard.summary(context.searchId);
    assert.equal(settled.committedUsd, 0.0000369); assert.equal(settled.settledUsd, 0.0000369); assert.equal(settled.heldUsd, 0); assert.equal(settled.unsettledAttempts, 0);
    await guard.reserve(body, context);
    const latest = await guard.summary(context.searchId);
    assert.equal(latest.committedUsd, 0.0001819); assert.equal(latest.heldUsd, 0.000145); assert.equal(latest.attempts, 2);
    assert.deepEqual(await createAiSpendingGuard({ directory }).summary(context.searchId), latest, "restart does not reset reported costs or unresolved holds");
    assert.equal((await guard.summary()).remainingUsd, null, "independent search allowances are not one global allowance");
    assert.equal((await guard.summary(randomUUID())).committedUsd, 0);
});
