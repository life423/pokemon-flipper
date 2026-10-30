import { test } from "node:test";
import assert from "node:assert/strict";
import { searchFailureMessage } from "../../server/deals/errors.ts";
import { EbayAuthenticationError, EbayError } from "../../server/ebay/api.ts";
import { EbayBudgetError } from "../../server/ebay/usage.ts";
import { ProviderError } from "../../server/lib/http.ts";

test("search errors retain actionable authentication, timeout and reserve messages", () => {
    for (const error of [new EbayAuthenticationError("Missing eBay keys. Add them to .env."), new ProviderError("eBay timed out. Retry later."), new EbayBudgetError("Preserving today's eBay allowance.")]) {
        assert.equal(searchFailureMessage(error), error.message);
    }
});
test("raw eBay and unexpected exceptions cannot expose their response body", () => {
    const privateText = "private-client-secret-do-not-show";
    for (const status of [400, 401, 403, 429, 500, 503]) assert.doesNotMatch(searchFailureMessage(new EbayError(privateText, status)), /private-client-secret/);
    assert.match(searchFailureMessage(new EbayError(privateText, 401)), /Production credentials/);
    assert.equal(searchFailureMessage(new Error(privateText)), "Failed to screen listings");
});
