import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/evaluate.ts", import.meta.url));
const deniedNetwork = "data:text/javascript," + encodeURIComponent('globalThis.fetch = () => { throw new Error("UNEXPECTED_PROVIDER_DISPATCH"); };');
function run(...args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", "--import", deniedNetwork, script, ...args], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env, OPENAI_API_KEY: "", PKMNPRICES_API_KEY: "", POKEMON_FLIPPER_STORAGE: "file" },
    });
}
test("retired CLI fresh-photo bypass is rejected before loading the evaluator or dispatching providers", () => {
    const result = run("123456789012", "--fresh");
    assert.equal(result.status, 1); assert.match(result.stderr, /--fresh photo reanalysis has been retired/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROVIDER_DISPATCH|Evaluating|OPENAI_API_KEY|SqlStorage|connect/);
});
test("CLI usage requires a listing without initiating a research scope or provider work", () => {
    const result = run();
    assert.equal(result.status, 1); assert.match(result.stdout, /Usage: npm run evaluate/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROVIDER_DISPATCH|Evaluating/);
});
test("CLI rejects invalid item IDs and links from other hosts before provider work", () => {
    for (const input of ["v1|invalid", "1234", "https://example.invalid/itm/123456789012"]) {
        const result = run(input);
        assert.equal(result.status, 1); assert.match(result.stdout, /Usage: npm run evaluate/);
        assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROVIDER_DISPATCH|Evaluating/);
    }
});
test("CLI rejects pick-your-card variations before provider work", () => {
    for (const input of ["v1|123456789012|7", "https://www.ebay.com/itm/123456789012?var=7"]) {
        const result = run(input);
        assert.equal(result.status, 1); assert.match(result.stderr, /Use a single-card listing/);
        assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROVIDER_DISPATCH|Evaluating/);
    }
});
test("CLI help describes evidence reuse without initiating provider work", () => {
    const result = run("--help");
    assert.equal(result.status, 0); assert.match(result.stdout, /unchanged paid photo evidence is reused/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROVIDER_DISPATCH|Evaluating/);
});
