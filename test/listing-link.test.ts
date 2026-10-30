import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListingLink, looksLikeListingLink } from "../shared/listing-link.ts";

test("tracked eBay links, slugs, mobile links and item IDs resolve to the same canonical listing", () => {
    const expected = { itemId: "v1|267743966894|0", url: "https://www.ebay.com/itm/267743966894" };
    for (const input of ["https://www.ebay.com/itm/267743966894?_skw=1999+mewtwo+base+set&epid=13043374779&itmprp=tracking%2Fdata&LH_BIN=1#photos", "https://ebay.com/itm/Mewtwo-Base-Set-Holo/267743966894/", "http://m.ebay.com/itm/267743966894", "www.ebay.com/itm/267743966894", "267743966894", " v1|267743966894|0 "]) {
        assert.deepEqual(parseListingLink(input), expected);
        assert.equal(looksLikeListingLink(input), true);
    }
});
test("URL parsing rejects lookalike domains, credentials, custom ports, unsupported paths and excessive input", () => {
    for (const input of [null, {}, "https://ebay.com.evil.example/itm/267743966894", "https://evil.example/itm/267743966894", "https://ebay.com@evil.example/itm/267743966894", "https://user:password@ebay.com/itm/267743966894", "https://ebay.com:8443/itm/267743966894", "file:///itm/267743966894", "javascript:alert(1)", "https://www.ebay.com/itm/267743966894/extra", "https://www.ebay.com/sch/i.html?q=mewtwo", "v1|267743966894|bogus", "https://www.ebay.com/itm/267743966894?var=1&var=2", "https://www.ebay.com/itm/267743966894?var=not-a-number", "https://www.ebay.com/itm/267743966894?x=" + "x".repeat(8192)]) assert.equal(parseListingLink(input), null, String(input).slice(0, 100));
});
test("normal card searches remain keywords; explicit variations keep their identity", () => {
    for (const input of ["1999 mewtwo base set", "1999", "PSA 9 Charizard", "10/102 holo"]) assert.equal(looksLikeListingLink(input), false);
    assert.equal(looksLikeListingLink("https://example.com/not-ebay"), true);
    assert.equal(parseListingLink("https://www.ebay.com/itm/267743966894?var=123456789012")?.itemId, "v1|267743966894|123456789012");
});
