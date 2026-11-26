import assert from "node:assert/strict";
import test from "node:test";
import { readFlipSession, writeFlipSession, type FlipSession } from "../../client/src/search/flip-session.ts";

test("resuming a flip retains the original leg, account and ZIP including its four-digit extension", () => {
    const entries = new Map<string, string>();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
        getItem: (key: string) => entries.get(key), setItem: (key: string, text: string) => entries.set(key, text),
    } });
    try {
        const id = "11223344-1234-4321-8765-123456789abc";
        const session: FlipSession = { id, destination: null, text: "", format: "FIXED_PRICE", expand: false, filters: {},
            targets: { minProfit: 0, minRoi: 0 }, minGrade: 0, prepared: { plan: null, legs: [{ id, format: "FIXED_PRICE", started: 0 }] } };
        for (const destination of [null, "76133", "76133-1234", "00123-0001"]) {
            const input = { ...session, destination };
            writeFlipSession(input);
            assert.deepEqual(readFlipSession(), input);
        }
        writeFlipSession({ ...session, destination: "12345-12" });
        assert.equal(readFlipSession(), null);
    } finally {
        if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
        else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
});
