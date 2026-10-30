import type { TestContext } from "node:test";

// API transport is mocked by each caller. Valid configuration is explicit so
// transport tests exercise requests, while missing-key tests remain meaningful.
export function offlineEbayCredentials(t: TestContext): void {
    for (const name of ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"]) {
        const previous = process.env[name];
        process.env[name] = "offline-fixture-only";
        t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    }
}
