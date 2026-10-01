import { MONEY_CONFIG, type MoneyConfig } from "./config.ts";
import { bestPath, pathNumbers, underwrite } from "./underwriting.ts";
import { rateDeal } from "./rating.ts";
import { isLongShot } from "./auction.ts";
import type { Evaluation, Screen, Targets } from "../types.ts";

// Your profit and return targets change by card, so the page re-prices
// everything for the targets you set. The same money math runs on the
// numbers the server already gathered: no new lookups, no AI.

export function withTargets(targets: Targets, config: MoneyConfig = MONEY_CONFIG): MoneyConfig {
    return { ...config, targets };
}

// An analyzed listing: every path, the verdict, and the rating, redone.
export function retargetEvaluation(evaluation: Evaluation, targets: Targets): Evaluation {
    const underwriting = underwrite(evaluation, withTargets(targets));
    const repriced = { ...evaluation, underwriting };

    return { ...repriced, rating: rateDeal(repriced) };
}

// A free check: whether the listing could clear your targets at its
// best, from the paths it priced.
export function retargetScreen(
    screen: Screen,
    price: number | null,
    targets: Targets,
    config: MoneyConfig = MONEY_CONFIG
): Screen {
    if (!screen.money || price === null || screen.status === "UNSCREENED") return screen;

    const repriced = withTargets(targets, config);
    const { shipping, paths, auction, usual } = screen.money;
    const priced = paths.map((path) => ({
        label: path.label,
        ...pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping, price }, repriced),
    }));
    const best = bestPath(priced);

    if (!best) return screen;

    return {
        ...screen,
        status: best.clears ? "CANDIDATE" : "DROPPED",
        bestCase: { label: best.label, maxBid: best.maxBid, profit: best.profit, roi: best.roi },
        longShot: best.clears && isLongShot(auction, usual, best.maxBid),
    };
}
