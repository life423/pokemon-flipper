import type { ReactNode } from "react";

// Simple line icons, drawn for this app. They take the text color and size.
type IconProps = { className?: string };

function Icon({ className, children }: IconProps & { children: ReactNode }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {children}
        </svg>
    );
}

export const SearchIcon = (props: IconProps) => (
    <Icon {...props}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
    </Icon>
);

export const TagIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M3 12V4h8l10 10-8 8L3 12Z" />
        <circle cx="7.5" cy="7.5" r="1.25" />
    </Icon>
);

export const ClockIcon = (props: IconProps) => (
    <Icon {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
    </Icon>
);

export const TrendIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="m3 17 6-6 4 4 8-8" />
        <path d="M15 7h6v6" />
    </Icon>
);

export const ReviewIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M7 3h7l5 5v13H7Z" />
        <path d="M14 3v5h5M10 13h6M10 17h6" />
    </Icon>
);

export const SparkleIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9Z" />
        <path d="M19 16v4M17 18h4" />
    </Icon>
);

export const GridIcon = (props: IconProps) => (
    <Icon {...props}>
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Icon>
);

export const DollarIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M12 3v18" />
        <path d="M16.5 7.5c0-1.9-2-3-4.5-3S7.5 5.7 7.5 7.7c0 4.6 9 2.4 9 7 0 2-2 3.3-4.5 3.3s-4.5-1.2-4.5-3" />
    </Icon>
);

export const SlidersIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
        <circle cx="15" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
    </Icon>
);

export const ChevronIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="m6 9 6 6 6-6" />
    </Icon>
);

export const CloseIcon = (props: IconProps) => (
    <Icon {...props}>
        <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
);

// The app's mark: two cards mid-flip, the front one with a rising line.
export function LogoMark({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
            <defs>
                <linearGradient id="logo-front" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3b82f6" />
                    <stop offset="1" stopColor="#22c55e" />
                </linearGradient>
            </defs>
            <rect x="7" y="6" width="19" height="27" rx="4" fill="#202531" stroke="#2a3140" strokeWidth="1.5" transform="rotate(-12 16.5 19.5)" />
            <rect x="13" y="7" width="19" height="27" rx="4" fill="url(#logo-front)" transform="rotate(8 22.5 20.5)" />
            <path d="m17 26 4.5-4.5 3 3 5-5.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M26 19h3.5v3.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
