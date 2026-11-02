import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { constrainPhotoView, initialPhotoView, PHOTO_ZOOM_MAX, zoomPhotoAt, type PhotoBounds, type PhotoPoint, type PhotoView } from "./photo-view";
import { useDialog } from "../useDialog";
import styles from "./DetailPanel.module.css";

export function PhotoGallery({ images }: { images: string[] }) {
    const photos = [...new Set(images)];
    const [selected, setSelected] = useState(0);
    const [view, setView] = useState(initialPhotoView);
    const [failed, setFailed] = useState(false);
    const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const gallery = useRef<HTMLElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const image = useRef<HTMLImageElement>(null);
    const currentView = useRef(view);
    const pointers = useRef(new Map<number, PhotoPoint>());
    const instructions = useId();
    useDialog(fullscreen, gallery, () => { void document.exitFullscreen().catch(() => {}); });
    const index = Math.min(selected, Math.max(0, photos.length - 1));
    const source = photos[index]?.replace(/\/s-l\d+\./, "/s-l1600.");

    const bounds = (): PhotoBounds => ({ width: viewport.current?.clientWidth || 1, height: viewport.current?.clientHeight || 1,
        imageWidth: image.current?.naturalWidth || 1, imageHeight: image.current?.naturalHeight || 1 });
    const update = (next: PhotoView) => { currentView.current = next; setView(next); };
    const reset = () => { pointers.current.clear(); update(initialPhotoView()); };
    const zoom = (value: number, point?: PhotoPoint) => {
        const size = bounds();
        update(zoomPhotoAt(currentView.current, value, point ?? { x: size.width / 2, y: size.height / 2 }, size));
    };
    const select = (value: number) => { reset(); setFailed(false); setSelected((value + photos.length) % photos.length); };
    const point = (clientX: number, clientY: number): PhotoPoint => {
        const rect = viewport.current!.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    useEffect(() => { reset(); setFailed(false); }, [source]);
    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const resize = () => update(constrainPhotoView(currentView.current, bounds()));
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        // A nonpassive native listener prevents the panel scrolling behind a
        // deliberate wheel zoom. Once outside the photo, scrolling is normal.
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
            zoom(currentView.current.zoom * Math.exp(-delta * 0.002), point(event.clientX, event.clientY));
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); };
    }, [source]);
    useEffect(() => {
        setFullscreenAvailable(Boolean(document.fullscreenEnabled && gallery.current?.requestFullscreen));
        const changed = () => setFullscreen(document.fullscreenElement === gallery.current);
        document.addEventListener("fullscreenchange", changed);
        return () => document.removeEventListener("fullscreenchange", changed);
    }, [Boolean(photos.length)]);

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, point(event.clientX, event.clientY));
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const previous = pointers.current.get(event.pointerId);
        if (!previous) return;
        const before = [...pointers.current.values()];
        const next = point(event.clientX, event.clientY);
        pointers.current.set(event.pointerId, next);
        const after = [...pointers.current.values()];
        if (before.length >= 2) {
            const distance = (points: PhotoPoint[]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
            const center = (points: PhotoPoint[]) => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
            const from = center(before), to = center(after), size = bounds();
            const adjusted = zoomPhotoAt(currentView.current, currentView.current.zoom * distance(after) / Math.max(1, distance(before)), from, size);
            update(constrainPhotoView({ ...adjusted, x: adjusted.x + to.x - from.x, y: adjusted.y + to.y - from.y }, size));
        } else if (currentView.current.zoom > 1) {
            update(constrainPhotoView({ ...currentView.current, x: currentView.current.x + next.x - previous.x, y: currentView.current.y + next.y - previous.y }, bounds()));
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "+" || event.key === "=") zoom(currentView.current.zoom * 1.5);
        else if (event.key === "-") zoom(currentView.current.zoom / 1.5);
        else if (event.key === "0" || event.key === "Home") reset();
        else if (event.key.startsWith("Arrow")) {
            if (currentView.current.zoom === 1) {
                if (event.key === "ArrowLeft") select(index - 1);
                else if (event.key === "ArrowRight") select(index + 1);
                else return;
            } else update(constrainPhotoView({ ...currentView.current,
                x: currentView.current.x + (event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0),
                y: currentView.current.y + (event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0),
            }, bounds()));
        } else return;
        event.preventDefault();
    };

    if (!photos.length) return <p className={styles.small}>No listing photos available.</p>;
    return <section ref={gallery} className={styles.gallery} aria-label="Listing photos" onKeyDownCapture={event => {
        if (fullscreen && event.key === "Escape") {
            event.preventDefault(); event.stopPropagation();
            void document.exitFullscreen().catch(() => {});
        }
    }}>
        <div className={styles.galleryHeader}>
            <h3 className={styles.sectionTitle}>Listing photos</h3>
            {fullscreenAvailable && <button type="button" className={styles.photoTextButton} onClick={() => {
                if (document.fullscreenElement === gallery.current) void document.exitFullscreen().catch(() => {});
                else void gallery.current?.requestFullscreen().catch(() => {});
            }}>{fullscreen ? "Exit full screen" : "Expand viewer"}</button>}
        </div>
        <div ref={viewport} className={styles.photoViewport} tabIndex={0} role="group" aria-label="Zoomable listing photo" aria-describedby={instructions}
            data-zoomed={view.zoom > 1} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
            onPointerUp={event => pointers.current.delete(event.pointerId)} onPointerCancel={event => pointers.current.delete(event.pointerId)}
            onLostPointerCapture={event => pointers.current.delete(event.pointerId)} onKeyDown={onKeyDown}
            onDoubleClick={event => zoom(currentView.current.zoom === 1 ? 3 : 1, point(event.clientX, event.clientY))}>
            <img ref={image} className={styles.heroPhoto} src={source} alt={`Listing photo ${index + 1} of ${photos.length}`} draggable={false} decoding="async"
                style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
                onLoad={() => update(constrainPhotoView(currentView.current, bounds()))} onError={() => setFailed(true)} />
            {failed && <p className={styles.photoError} role="status">This photo could not load. Try opening the original below.</p>}
        </div>
        <div className={styles.galleryNav}>
            <button type="button" onClick={() => select(index - 1)} disabled={photos.length < 2} aria-label="Previous photo">←</button>
            <span aria-live="polite" aria-atomic="true">Photo {index + 1} of {photos.length}</span>
            <button type="button" onClick={() => select(index + 1)} disabled={photos.length < 2} aria-label="Next photo">→</button>
        </div>
        <div className={styles.zoomControls} role="group" aria-label="Photo zoom controls">
            <button type="button" onClick={() => zoom(currentView.current.zoom / 1.5)} disabled={view.zoom <= 1} aria-label="Zoom out">−</button>
            <input type="range" min={1} max={PHOTO_ZOOM_MAX} step={0.25} value={view.zoom} aria-label="Photo zoom" aria-valuetext={`${view.zoom.toFixed(1)} times`}
                onChange={event => zoom(Number(event.target.value))} />
            <output aria-label="Zoom level">{Number(view.zoom.toFixed(1))}×</output>
            <button type="button" onClick={() => zoom(currentView.current.zoom * 1.5)} disabled={view.zoom >= PHOTO_ZOOM_MAX} aria-label="Zoom in">+</button>
            <button type="button" className={styles.photoTextButton} onClick={reset} disabled={view.zoom === 1 && view.x === 0 && view.y === 0}>Reset view</button>
        </div>
        <p id={instructions} className={styles.small}>Pinch or scroll to zoom; drag to move. Keyboard: +/− to zoom, arrows to move, 0 to reset. At 1×, left/right change photos.</p>
        <p className={styles.small}>Zoom enlarges the original image; it cannot recover missing detail. <a className={styles.originalPhoto} href={source} target="_blank" rel="noopener noreferrer">Open original photo ↗</a></p>
        {photos.length > 1 && <details className={styles.photoChoices}><summary>Choose a photo ({photos.length})</summary>
            <div className={styles.thumbnails}>{photos.map((src, i) => <button type="button" key={src} aria-label={`Show photo ${i + 1}`} aria-pressed={i === index} onClick={() => select(i)}><img src={src} alt="" loading="lazy" /></button>)}</div>
        </details>}
    </section>;
}
