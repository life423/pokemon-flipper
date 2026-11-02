import "./isolated-data.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { aiSpending } from "../../server/ai/spending.ts";

// Explicit test dependency injection, never imported by production. SDK tests
// can exercise their mock responses without enabling a real spending guard.
// Even this test-only substitute refuses to authorize an unmocked transport.
mock.method(aiSpending, "reserve", async () => {
    const fetch = globalThis.fetch as typeof globalThis.fetch & { mock?: { callCount?: unknown } };
    assert.equal(typeof fetch.mock?.callCount, "function", "offline AI spending injection requires node:test's mocked fetch");
    return null;
});
mock.method(aiSpending, "settle", async () => {});
