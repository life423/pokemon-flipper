import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { CONDITION_NAMES } from "../../../shared/conditions.ts";
import type { CameraGradeResult } from "../../../shared/camera-grade.ts";
import { gradeCameraCard } from "../api";
import { jpegFrame, readCameraPhoto } from "./camera-photo";
import styles from "./CameraGrade.module.css";

const views = {
    front: { title: "Front", hint: "Face the card straight on. Include all four corners and the full border." },
    back: { title: "Back", hint: "Use a dark, plain background so whitening along the edges is visible." },
    tilted: { title: "Tilted front", hint: "Tilt the card slightly so the light shows scratches across the holo surface." },
} as const;
type View = keyof typeof views;

function CameraPreview({ view, onCapture, onClose }: { view: View; onCapture: (photo: string) => void; onClose: () => void }) {
    const video = useRef<HTMLVideoElement>(null);
    const [device, setDevice] = useState("");
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let closed = false;
        let stream: MediaStream | undefined;
        setReady(false); setError("");
        async function connect() {
            if (closed) return;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
                    ...(device ? { deviceId: { exact: device } } : { facingMode: { ideal: "environment" } }),
                    width: { ideal: 2560 }, height: { ideal: 1920 },
                } });
                if (closed || !video.current) { stream.getTracks().forEach(track => track.stop()); return; }
                video.current.srcObject = stream;
                await video.current.play();
                if (closed) return;
                setReady(true);
                const available = await navigator.mediaDevices.enumerateDevices().catch(() => []);
                if (!closed) setDevices(available.filter(source => source.kind === "videoinput"));
            } catch {
                stream?.getTracks().forEach(track => track.stop());
                if (!closed) setError("Couldn’t open this camera. Check camera permission, or choose a photo from your device.");
            }
        }
        void Promise.resolve().then(connect);
        return () => { closed = true; stream?.getTracks().forEach(track => track.stop()); };
    }, [device]);
    function capture() {
        const source = video.current;
        if (!source) return;
        try { onCapture(jpegFrame(source, source.videoWidth, source.videoHeight)); onClose(); }
        catch (cause) { setError((cause as Error).message); }
    }
    return <div className={styles.live}>
        {!error && <video ref={video} autoPlay muted playsInline aria-label={`Live camera for ${views[view].title.toLowerCase()}`} />}
        {error ? <p role="alert" className={styles.error}>{error}</p> : !ready && <p role="status">Opening camera…</p>}
        {devices.length > 1 && <label>Camera <select value={device} onChange={event => setDevice(event.target.value)}>
            <option value="">Preferred camera</option>
            {devices.map((source, index) => <option key={source.deviceId} value={source.deviceId}>{source.label || `Camera ${index + 1}`}</option>)}
        </select></label>}
        <div className={styles.actions}>
            <button type="button" className={styles.action} disabled={!ready || !!error} onClick={capture}>Take photo</button>
            <button type="button" className={styles.remove} onClick={onClose}>Close camera</button>
        </div>
    </div>;
}

function PhotoSlot({ view, photo, busy, live, openCamera, closeCamera, onFile, onPhoto }: {
    view: View; photo?: string; busy: boolean; live: boolean;
    openCamera: () => void; closeCamera: () => void; onFile: (file: File) => void; onPhoto: (data?: string) => void;
}) {
    const camera = useRef<HTMLInputElement>(null);
    const file = useRef<HTMLInputElement>(null);
    const { title, hint } = views[view];
    function choose(event: ChangeEvent<HTMLInputElement>) {
        const selected = event.target.files?.[0];
        event.target.value = "";
        if (selected) onFile(selected);
    }
    function shoot() {
        if (window.matchMedia("(pointer: coarse)").matches || !navigator.mediaDevices?.getUserMedia) camera.current?.click();
        else openCamera();
    }
    return <section aria-label={title + " photo"} className={styles.slot}>
        <h3>{title}</h3>
        <p className={styles.hint}>{hint}</p>
        {live ? <CameraPreview view={view} onCapture={onPhoto} onClose={closeCamera} /> :
            <div className={styles.preview}>
                {photo ? <img src={photo} alt={title + " photo to be assessed"} /> :
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                        <path d="M3 8a1 1 0 0 1 1-1h4l2-3h4l2 3h4a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><circle cx="12" cy="13" r="3.5" />
                    </svg>}
            </div>}
        <div className={styles.actions}>
            {!live && <button className={styles.action} type="button" disabled={busy} onClick={shoot}
                aria-label={`${photo ? "Retake" : "Capture"} ${title.toLowerCase()} photo`}>{photo ? "Retake" : "Use camera"}</button>}
            <button className={styles.action} type="button" disabled={busy} onClick={() => file.current?.click()}
                aria-label={`Choose ${title.toLowerCase()} photo from device`}>Choose photo</button>
            {photo && <button className={styles.remove} type="button" disabled={busy} onClick={() => onPhoto()}
                aria-label={`Remove ${title.toLowerCase()} photo`}>Remove</button>}
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={choose} />
        <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/heif,image/heic,.heif,.heic" hidden onChange={choose} />
    </section>;
}

function Assessment({ result }: { result: CameraGradeResult }) {
    const condition = result.condition && result.condition !== "UNKNOWN" ? CONDITION_NAMES[result.condition] : "Uncertain";
    const confidence = result.confidence[0] + result.confidence.slice(1).toLowerCase();
    return <section className={styles.result} aria-label="Photo assessment">
        <h3>{result.status === "retake" ? "Retake needed" : result.status === "slab" ? "Graded card" : "Grade estimate"}{result.cardName && ` · ${result.cardName}`}</h3>
        {result.status === "graded" && <>
            <dl className={styles.facts}>
                <div><dt>Estimated grade</dt><dd className={styles.number}>{result.grade} / 10</dd></div>
                <div><dt>Play condition</dt><dd>{condition}</dd></div>
                <div><dt>Photo confidence</dt><dd>{confidence}</dd></div>
            </dl>
            <p className={styles.detail}>A photo estimate can differ from a professional in-hand grade.</p>
        </>}
        {result.status === "slab" && <>
            <p><strong>{result.observations[0] ?? `Label grade ${result.grade}`}</strong></p>
            <p className={styles.detail}>{confidence} confidence reading the slab label.</p>
        </>}
        {result.status !== "slab" && result.observations.length > 0 && <><h4>What the photos show</h4><ul>{result.observations.map((note, index) => <li key={index}>{note}</li>)}</ul></>}
        {result.guidance.length > 0 && <div className={result.status === "retake" ? styles.retake : styles.detail}>
            <ul>{result.guidance.map((note, index) => <li key={index}>{note}</li>)}</ul>
        </div>}
    </section>;
}

export function CameraGrade() {
    const [photos, setPhotos] = useState<Partial<Record<View, string>>>({});
    const [camera, setCamera] = useState<View | null>(null);
    const [preparing, setPreparing] = useState(false);
    const [grading, setGrading] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<CameraGradeResult | null>(null);
    const request = useRef<AbortController | null>(null);
    const busy = preparing || grading;
    useEffect(() => () => request.current?.abort(), []);

    function change(view: View, photo?: string) {
        setPhotos(prev => ({ ...prev, [view]: photo }));
        setResult(null); setError(""); setCamera(null);
    }
    async function select(view: View, file: File) {
        setError(""); setCamera(null); setPreparing(true);
        try { change(view, await readCameraPhoto(file)); }
        catch (cause) { setError(`${views[view].title} photo. ${(cause as Error).message}`); }
        finally { setPreparing(false); }
    }
    async function grade() {
        if (busy || !photos.front || !photos.back || request.current || result) return;
        setCamera(null); setError(""); setGrading(true);
        const controller = new AbortController();
        request.current = controller;
        try {
            const answer = await gradeCameraCard({ front: photos.front, back: photos.back, tilted: photos.tilted }, controller.signal);
            if (!controller.signal.aborted) setResult(answer);
        } catch (cause) {
            if (!controller.signal.aborted) setError((cause as Error).message);
        } finally { request.current = null; setGrading(false); }
    }
    function slot(view: View) {
        return <PhotoSlot view={view} photo={photos[view]} busy={busy} live={camera === view}
            openCamera={() => setCamera(view)} closeCamera={() => setCamera(null)} onFile={file => void select(view, file)}
            onPhoto={photo => change(view, photo)} />;
    }
    return <section className={styles.workspace} aria-label="Camera grading">
        <header className={styles.intro}><h2>Grade a card</h2>
            <p>Photograph one raw card in even light. Take it out of the sleeve when you can.</p>
        </header>
        <div className={styles.photos}>{slot("front")}{slot("back")}</div>
        <details className={styles.optional} onToggle={event => { if (!event.currentTarget.open && camera === "tilted") setCamera(null); }}>
            <summary>Tilted holo photo <span>· {photos.tilted ? "Added" : "Optional"}</span></summary>
            {slot("tilted")}
        </details>
        <div className={styles.submission}>
            <button type="button" className={styles.gradeButton} disabled={busy || !!result || !photos.front || !photos.back} onClick={() => void grade()}>
                {grading ? "Grading…" : "Estimate grade"}
            </button>
            <p role="status">{preparing ? "Preparing photo…" : grading ? "Checking front and back for visible wear…" :
                !photos.front || !photos.back ? "Add the front and back to get an estimate." :
                result ? "Replace a photo to assess the card again." : "Submitting sends these photos to OpenAI for grading."}</p>
        </div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div aria-live="polite" aria-atomic="true">{result && <Assessment result={result} />}</div>
        {result && <div><button type="button" className={styles.action} disabled={busy} onClick={() => {
            setPhotos({}); setResult(null); setError(""); setCamera(null);
        }}>Grade another card</button></div>}
    </section>;
}
