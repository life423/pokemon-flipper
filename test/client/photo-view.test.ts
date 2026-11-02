import { test } from "node:test";
import assert from "node:assert/strict";
import { constrainPhotoView, initialPhotoView, zoomPhotoAt } from "../../client/src/components/photo-view.ts";

const portrait = { width: 300, height: 300, imageWidth: 400, imageHeight: 560 };

test("zoom keeps the selected image point fixed and supports close inspection up to 16×", () => {
    const point = { x: 170, y: 100 };
    const next = zoomPhotoAt(initialPhotoView(), 3, point, portrait);
    assert.equal(next.zoom, 3);
    assert.equal(next.x, -40); assert.equal(next.y, 100);
    // The same source pixel stays under the focal point after the transform.
    assert.equal((point.x - 150 - next.x) / next.zoom, point.x - 150);
    assert.equal((point.y - 150 - next.y) / next.zoom, point.y - 150);
    assert.equal(zoomPhotoAt(next, 100, point, portrait).zoom, 16);
    assert.deepEqual(zoomPhotoAt(next, 0.1, point, portrait), initialPhotoView());
});

test("pan clamps to the contained image edges and respects portrait/landscape letterboxing", () => {
    assert.deepEqual(constrainPhotoView({ zoom: 1, x: 1000, y: -1000 }, portrait), initialPhotoView());
    const portraitPan = constrainPhotoView({ zoom: 2, x: 1000, y: -1000 }, portrait);
    assert.ok(Math.abs(portraitPan.x - (300 * 400 / 560 * 2 - 300) / 2) < 1e-9);
    assert.equal(portraitPan.y, -150);
    const landscape = { width: 300, height: 300, imageWidth: 800, imageHeight: 400 };
    assert.deepEqual(constrainPhotoView({ zoom: 2, x: -1000, y: 1000 }, landscape), { zoom: 2, x: -150, y: 0 });
    const resized = constrainPhotoView(portraitPan, { ...portrait, width: 600, height: 600 });
    assert.equal(resized.zoom, 2); assert.equal(resized.x, portraitPan.x);
});
