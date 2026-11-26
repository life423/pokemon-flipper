import { resaleReviewBand, type ResaleReviewBand } from "../deals/discovery-order.ts";

export interface FlipReviewPriority {
    band: ResaleReviewBand;
    market: string;
}

// Rows arrive in separately ranked eBay pages. Compare across those pages
// without rescanning the backlog when one copy finishes.
export class FlipReviewQueue {
    private readonly pending: number[] = [];
    private readonly ranks: { band: number; turn: number }[] = [];
    private readonly marketCounts = new Map<string, number>();

    add(index: number, priority?: FlipReviewPriority) {
        const key = priority && JSON.stringify([priority.band, priority.market]);
        const turn = key ? this.marketCounts.get(key) ?? 0 : 0;
        if (key) this.marketCounts.set(key, turn + 1);
        this.ranks[index] = { band: priority?.band ?? resaleReviewBand.unresolved, turn };
        this.requeue(index);
    }

    compare = (a: number, b: number) => this.ranks[b].band - this.ranks[a].band ||
        this.ranks[a].turn - this.ranks[b].turn || a - b;

    requeue(index: number) {
        let slot = this.pending.length;
        this.pending.push(index);
        while (slot > 0) {
            const parent = Math.floor((slot - 1) / 2);
            if (this.compare(index, this.pending[parent]) >= 0) break;
            this.pending[slot] = this.pending[parent];
            slot = parent;
        }
        this.pending[slot] = index;
    }

    take(): number {
        const first = this.pending[0];
        const last = this.pending.pop()!;
        if (!this.pending.length) return first;
        let slot = 0;
        for (let child = 1; child < this.pending.length; child = 2 * slot + 1) {
            if (child + 1 < this.pending.length && this.compare(this.pending[child + 1], this.pending[child]) < 0) child++;
            if (this.compare(last, this.pending[child]) <= 0) break;
            this.pending[slot] = this.pending[child];
            slot = child;
        }
        this.pending[slot] = last;
        return first;
    }
}
