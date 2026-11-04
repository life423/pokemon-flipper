import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkCommand } from "../../scripts/review/benchmark-command.ts";

test("a paid retest requires explicit live mode and retains its report instead of accepting a new query", () => {
    assert.deepEqual(benchmarkCommand(["--live", "--resume", "saved/report.json"]), { mode: "resume", file: "saved/report.json" });
    assert.deepEqual(benchmarkCommand(["--replay", "saved/report.json"]), { mode: "replay", file: "saved/report.json" });
    assert.deepEqual(benchmarkCommand(["--live", "--query", " Snorlax Jungle "]), { mode: "live", query: "Snorlax Jungle" });
    for (const args of [[], ["--resume", "saved/report.json"], ["--live", "--replay", "saved/report.json"],
        ["--live", "--resume", "saved/report.json", "--query", "different search"],
        ["--live", "--query", "q", "--query", "q"], ["--live", "--query"],
        ["--live", "--query", "q", "--reset-budget"], ["--live", "--live", "--query", "q"]]) {
        assert.throws(() => benchmarkCommand(args));
    }
});
