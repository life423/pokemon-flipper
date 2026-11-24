import { useState } from "react";

export function ListingThumbnail({ images, alt, eager = false }: { images: string[]; alt: string; eager?: boolean }) {
    const [failed, setFailed] = useState<string[]>([]);
    const src = images.find(url => url && !failed.includes(url));
    return src ? <img src={src} alt={alt} loading={eager ? "eager" : "lazy"}
        onError={() => setFailed(previous => previous.includes(src) ? previous : [...previous, src])} /> : <span>No photo</span>;
}
