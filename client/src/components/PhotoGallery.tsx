import { useState } from "react";
import styles from "./DetailPanel.module.css";

export function PhotoGallery({ images }: { images: string[] }) {
    const photos = [...new Set(images)];
    const [selected, setSelected] = useState(0);
    if (!photos.length) return <p className={styles.small}>No listing photos available.</p>;
    const index = Math.min(selected, photos.length - 1);
    return <details className={styles.gallery}>
        <summary>View {photos.length} listing {photos.length === 1 ? "photo" : "photos"}</summary>
        <img className={styles.heroPhoto} src={photos[index]} alt={`Listing photo ${index + 1}`} loading="lazy" />
        {photos.length > 1 && <div className={styles.galleryNav}>
            <button type="button" onClick={() => setSelected((index + photos.length - 1) % photos.length)} aria-label="Previous photo">←</button>
            <span>{index + 1} of {photos.length}</span>
            <button type="button" onClick={() => setSelected((index + 1) % photos.length)} aria-label="Next photo">→</button>
        </div>}
        <div className={styles.thumbnails}>{photos.map((src, i) => <button type="button" key={src} aria-label={`Show photo ${i + 1}`} aria-pressed={i === index} onClick={() => setSelected(i)}><img src={src} alt="" loading="lazy" /></button>)}</div>
    </details>;
}
