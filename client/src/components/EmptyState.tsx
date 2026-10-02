import styles from "./EmptyState.module.css";

// Before the first search: what the app is for, and where to start.
export function EmptyState({
    title = "Find your next flip",
    text = "Search for a card above to scan eBay for profitable listings.",
    framed = false,
}: {
    title?: string;
    text?: string;
    // In a card of its own, among other cards.
    framed?: boolean;
}) {
    return (
        <div className={`${styles.empty} ${framed ? styles.framed : ""}`}>
            <svg className={styles.art} viewBox="0 0 220 170" aria-hidden="true">
                <defs>
                    <linearGradient id="empty-edge" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#3b82f6" />
                        <stop offset="1" stopColor="#22c55e" />
                    </linearGradient>
                    <linearGradient id="empty-face" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#1d2433" />
                        <stop offset="1" stopColor="#151a23" />
                    </linearGradient>
                </defs>
                {/* The card behind, mid-flip. */}
                <rect x="104" y="30" width="74" height="104" rx="10" fill="#171a21" stroke="#2a3140" strokeWidth="2" transform="rotate(14 141 82)" />
                {/* The card in front: a gradient edge, and the Poke Ball at its center. */}
                <g transform="rotate(-8 100 86)">
                    <rect x="62" y="28" width="78" height="110" rx="11" fill="url(#empty-edge)" />
                    <rect x="67" y="33" width="68" height="100" rx="8" fill="url(#empty-face)" />
                    <circle cx="101" cy="83" r="30" fill="#3b82f6" opacity="0.14" />
                    <image href="/pokeball.png" x="77" y="59" width="48" height="48" />
                </g>
                {/* Sparkles. */}
                <path d="M40 52l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#3b82f6" />
                <path d="M188 112l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#3b82f6" opacity="0.8" />
                <path d="M52 120l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" fill="#22c55e" opacity="0.7" />
            </svg>
            <h2>{title}</h2>
            <p>{text}</p>
        </div>
    );
}
