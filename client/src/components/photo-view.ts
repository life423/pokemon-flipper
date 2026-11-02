export interface PhotoView { zoom: number; x: number; y: number }
export interface PhotoBounds { width: number; height: number; imageWidth: number; imageHeight: number }
export interface PhotoPoint { x: number; y: number }
export const PHOTO_ZOOM_MAX = 16;
export const initialPhotoView = (): PhotoView => ({ zoom: 1, x: 0, y: 0 });
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

// object-fit: contain preserves the original aspect ratio. Pan bounds use the
// actual drawn image, excluding any letterboxing around it.
export function constrainPhotoView(view: PhotoView, bounds: PhotoBounds): PhotoView {
    const zoom = clamp(view.zoom, 1, PHOTO_ZOOM_MAX);
    const fit = Math.min(bounds.width / bounds.imageWidth, bounds.height / bounds.imageHeight);
    const maxX = Math.max(0, (bounds.imageWidth * fit * zoom - bounds.width) / 2);
    const maxY = Math.max(0, (bounds.imageHeight * fit * zoom - bounds.height) / 2);
    return { zoom, x: maxX ? clamp(view.x, -maxX, maxX) : 0, y: maxY ? clamp(view.y, -maxY, maxY) : 0 };
}

// Keep the pixel under the pointer/finger in place while zooming, until a
// physical image edge requires clamping the pan back into the viewport.
export function zoomPhotoAt(view: PhotoView, zoom: number, point: PhotoPoint, bounds: PhotoBounds): PhotoView {
    const nextZoom = clamp(zoom, 1, PHOTO_ZOOM_MAX);
    const ratio = nextZoom / view.zoom;
    return constrainPhotoView({ zoom: nextZoom,
        x: view.x * ratio + (point.x - bounds.width / 2) * (1 - ratio),
        y: view.y * ratio + (point.y - bounds.height / 2) * (1 - ratio),
    }, bounds);
}
