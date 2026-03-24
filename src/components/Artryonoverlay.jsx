/**
 * ARTryOnOverlay.jsx  — production-ready virtual try-on engine
 *
 * PNG GARMENT FITTING ALGORITHM
 * ─────────────────────────────
 * Standard PNG garments are designed for a "canonical" body photographed
 * straight-on at a known shoulder width. To fit ANY body type:
 *
 *  1. Measure the detected shoulder width in pixels  (bodyShoulderPx)
 *  2. Assume the PNG was designed with ~60% of image width as shoulder span
 *     (GARMENT_SHOULDER_RATIO — adjustable per garment via garmentConfig prop)
 *  3. scale = bodyShoulderPx / (imgWidth * GARMENT_SHOULDER_RATIO)
 *  4. Place the scaled image so its shoulder line aligns with the body's
 *     shoulder midpoint, then shift up by NECK_OFFSET_RATIO to cover neck/collar
 *  5. Rotate the image by the detected shoulder tilt angle
 *  6. Aspect ratio is always preserved — no distortion
 *
 * This means a 600px wide PNG works the same as a 1200px PNG.
 * It means a slim person and a broad-shouldered person both get correct fit.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";

// ─── MediaPipe CDN scripts ────────────────────────────────────────────────────
const MP_SCRIPTS = [
    "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js",
    "https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js",
    "https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js",
];

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement("script");
        s.src = src; s.crossOrigin = "anonymous";
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load: ${src}`));
        document.head.appendChild(s);
    });
}

function waitForGlobal(name, timeout = 10000) {
    return new Promise((resolve, reject) => {
        if (typeof window[name] === "function") { resolve(); return; }
        let elapsed = 0;
        const iv = setInterval(() => {
            elapsed += 50;
            if (typeof window[name] === "function") { clearInterval(iv); resolve(); }
            else if (elapsed >= timeout) { clearInterval(iv); reject(new Error(`${name} never loaded`)); }
        }, 50);
    });
}

// ─── Pose landmark indices ────────────────────────────────────────────────────
const LM = {
    NOSE: 0, LEFT_EYE: 2, RIGHT_EYE: 5,
    LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
    LEFT_WRIST: 15, RIGHT_WRIST: 16,
    LEFT_HIP: 23, RIGHT_HIP: 24,
    LEFT_KNEE: 25, RIGHT_KNEE: 26,
};

const CREDIT_CARD_WIDTH_CM = 8.56;

// ─── Garment fitting constants ────────────────────────────────────────────────
// These describe the "canonical" PNG layout.
// SHOULDER_RATIO: what fraction of the PNG width spans shoulder-to-shoulder
// NECK_OFFSET:    how far above the shoulder midpoint the garment top sits
//                 (as a fraction of garment height) — covers collar/neck area
const DEFAULT_GARMENT_CONFIG = {
    shoulderRatio: 0.55,   // shoulders span 55% of image width
    neckOffset: 0.18,   // top of garment is 18% of garment height above shoulders
    hipExtend: 0.08,   // extend 8% below hip landmarks
};

// ─── Smoothing ────────────────────────────────────────────────────────────────
// Exponential moving average applied to garment position/scale
// to prevent jitter. Higher alpha = more responsive, less smooth.
const SMOOTH_ALPHA = 0.25;

function lerp(a, b, t) { return a + (b - a) * t; }

// ─── Measurement helpers ──────────────────────────────────────────────────────
function px(lm, idx, W, H) {
    return { x: lm[idx].x * W, y: lm[idx].y * H };
}
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function calibrateFromReference(pixelWidth, realWidthCm = CREDIT_CARD_WIDTH_CM) {
    return (!pixelWidth || pixelWidth <= 0) ? 0 : pixelWidth / realWidthCm;
}

export function estimateDimensions(landmarks, W, H, ppcm) {
    if (!landmarks || ppcm <= 0) return null;
    const ls = px(landmarks, LM.LEFT_SHOULDER, W, H);
    const rs = px(landmarks, LM.RIGHT_SHOULDER, W, H);
    const lh = px(landmarks, LM.LEFT_HIP, W, H);
    const rh = px(landmarks, LM.RIGHT_HIP, W, H);
    const sm = mid(ls, rs);
    const hm = mid(lh, rh);
    const nose = px(landmarks, LM.NOSE, W, H);
    return {
        shoulderWidthCm: (dist(ls, rs) / ppcm).toFixed(1),
        torsoHeightCm: (dist(sm, hm) / ppcm).toFixed(1),
        hipWidthCm: (dist(lh, rh) / ppcm).toFixed(1),
        estimatedHeightCm: (dist(nose, hm) * 2.5 / ppcm).toFixed(1),
    };
}

// ─── Core garment renderer ────────────────────────────────────────────────────
/**
 * drawGarment — scales PNG to fit ANY body type
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLImageElement} img        — the garment PNG (any size)
 * @param {Array} lm                   — mirrored pose landmarks
 * @param {number} W, H               — canvas dimensions
 * @param {object} smooth              — mutable smoothing state object
 * @param {object} config              — garment fitting config
 * @param {number} opacity
 */
function drawGarment(ctx, img, lm, W, H, smooth, config, opacity) {
    if (!img || !lm) return;

    const ls = px(lm, LM.LEFT_SHOULDER, W, H);
    const rs = px(lm, LM.RIGHT_SHOULDER, W, H);
    const lh = px(lm, LM.LEFT_HIP, W, H);
    const rh = px(lm, LM.RIGHT_HIP, W, H);

    // Guard: landmarks must be confident enough
    if (lm[LM.LEFT_SHOULDER].visibility < 0.4) return;
    if (lm[LM.RIGHT_SHOULDER].visibility < 0.4) return;

    const sm = mid(ls, rs);           // shoulder midpoint
    const hm = mid(lh, rh);           // hip midpoint
    const shoulderPx = dist(ls, rs);           // body shoulder width in px
    const shoulderAngle = Math.atan2(rs.y - ls.y, rs.x - ls.x);

    // ── Scale: fit PNG shoulder span to body shoulder span ────────────────────
    const { shoulderRatio, neckOffset, hipExtend } = config;
    const targetW = shoulderPx / shoulderRatio;         // desired garment width
    const imgAspect = img.naturalHeight / img.naturalWidth;
    const targetH = targetW * imgAspect;                // preserve aspect ratio

    // ── Position: anchor at shoulder midpoint, shift up for neck/collar ───────
    const torsoH = dist(sm, hm);
    const anchorX = sm.x;
    const anchorY = sm.y - targetH * neckOffset;

    // ── Smooth to avoid jitter ────────────────────────────────────────────────
    if (smooth.x === undefined) {
        smooth.x = anchorX; smooth.y = anchorY;
        smooth.w = targetW; smooth.h = targetH; smooth.a = shoulderAngle;
    } else {
        smooth.x = lerp(smooth.x, anchorX, SMOOTH_ALPHA);
        smooth.y = lerp(smooth.y, anchorY, SMOOTH_ALPHA);
        smooth.w = lerp(smooth.w, targetW, SMOOTH_ALPHA);
        smooth.h = lerp(smooth.h, targetH, SMOOTH_ALPHA);
        smooth.a = lerp(smooth.a, shoulderAngle, SMOOTH_ALPHA);
    }

    // ── Draw ─────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(smooth.x, smooth.y);
    ctx.rotate(smooth.a);
    ctx.drawImage(img, -smooth.w / 2, 0, smooth.w, smooth.h);
    ctx.restore();
}

// ─── Fallback outline (shown while PNG loads) ─────────────────────────────────
function drawFallback(ctx, lm, W, H) {
    if (!lm) return;
    const ls = px(lm, LM.LEFT_SHOULDER, W, H);
    const rs = px(lm, LM.RIGHT_SHOULDER, W, H);
    const lh = px(lm, LM.LEFT_HIP, W, H);
    const rh = px(lm, LM.RIGHT_HIP, W, H);
    if (!ls || !rs) return;

    const sw = dist(ls, rs);
    const pad = sw * 0.15;
    const slvL = { x: ls.x - sw * 0.32, y: ls.y + sw * 0.2 };
    const slvR = { x: rs.x + sw * 0.32, y: rs.y + sw * 0.2 };
    const neckMid = mid(ls, rs);
    const neckDip = { x: neckMid.x, y: neckMid.y + sw * 0.12 };

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(slvL.x, slvL.y);
    ctx.lineTo(ls.x - pad, ls.y);
    ctx.lineTo(ls.x - pad + sw * 0.1, neckDip.y - sw * 0.05);
    ctx.quadraticCurveTo(neckMid.x, neckDip.y + sw * 0.05, rs.x + pad - sw * 0.1, neckDip.y - sw * 0.05);
    ctx.lineTo(rs.x + pad, rs.y);
    ctx.lineTo(slvR.x, slvR.y);
    ctx.lineTo(rh.x + pad, rh.y + sw * 0.05);
    ctx.lineTo(lh.x - pad, lh.y + sw * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `bold ${Math.max(12, sw * 0.09)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cy = (ls.y + lh.y) / 2;
    ctx.fillText("Place PNG in public/garments/", neckMid.x, cy - 10);
    ctx.font = `${Math.max(10, sw * 0.07)}px sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText("Overlay aligned — ready for your PNG", neckMid.x, cy + 14);
    ctx.restore();
}

// ─── Measurement HUD ─────────────────────────────────────────────────────────
function drawHUD(ctx, dims, W, H) {
    const entries = [
        ["Shoulder", dims.shoulderWidthCm + " cm"],
        ["Torso", dims.torsoHeightCm + " cm"],
        ["Hips", dims.hipWidthCm + " cm"],
        ["Height", dims.estimatedHeightCm + " cm"],
    ];
    const bw = 170, lh = 24, pad = 12, bh = entries.length * lh + pad * 2;
    const x = 16, y = H - bh - 16, r = 10;

    ctx.save();
    // Glassmorphism panel
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, bw, bh, r) : (
        ctx.moveTo(x + r, y), ctx.arcTo(x + bw, y, x + bw, y + bh, r),
        ctx.arcTo(x + bw, y + bh, x, y + bh, r), ctx.arcTo(x, y + bh, x, y, r),
        ctx.arcTo(x, y, x + bw, y, r), ctx.closePath()
    );
    ctx.fill();

    ctx.strokeStyle = "rgba(0,255,170,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    entries.forEach(([label, val], i) => {
        const row = y + pad + i * lh + lh / 2;
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "11px 'SF Mono', 'Fira Code', monospace";
        ctx.textAlign = "left";
        ctx.fillText(label, x + pad, row + 4);
        ctx.fillStyle = "#00ffaa";
        ctx.font = "bold 12px 'SF Mono', 'Fira Code', monospace";
        ctx.textAlign = "right";
        ctx.fillText(val, x + bw - pad, row + 4);
    });
    ctx.restore();
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ARTryOnOverlay({
    agoraLocalTrack = null,
    garmentSrc = null,
    garmentType = "2d",
    garmentConfig = DEFAULT_GARMENT_CONFIG,
    referencePixelWidth = 0,
    referenceWidthCm = CREDIT_CARD_WIDTH_CM,
    showSkeleton = false,
    showMeasurements = true,
    garmentOpacity = 0.92,
    onMeasurement = () => { },
    onCalibrated = () => { },
}) {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const poseRef = useRef(null);
    const cameraRef = useRef(null);
    const garmentImg = useRef(null);
    const animFrameRef = useRef(null);
    const measureRef = useRef(null);
    const smoothRef = useRef({});          // smoothing state per garment

    const [poseReady, setPoseReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [ppcm, setPpcm] = useState(0);
    const [measurements, setMeasurements] = useState(null);
    const [fps, setFps] = useState(0);
    const [imgReady, setImgReady] = useState(false);
    const [loadError, setLoadError] = useState(null);

    const fpsRef = useRef({ frames: 0, last: performance.now() });
    const trackFps = useCallback(() => {
        const now = performance.now();
        fpsRef.current.frames++;
        if (now - fpsRef.current.last >= 1000) {
            setFps(fpsRef.current.frames);
            fpsRef.current.frames = 0;
            fpsRef.current.last = now;
        }
    }, []);

    // ── Load MediaPipe ────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        Promise.all(MP_SCRIPTS.map(loadScript))
            .then(() => waitForGlobal("Pose"))
            .then(() => { if (!cancelled) setPoseReady(true); })
            .catch(err => { if (!cancelled) setLoadError(err.message); });
        return () => { cancelled = true; };
    }, []);

    // ── Load garment PNG ──────────────────────────────────────────────────────
    useEffect(() => {
        if (!garmentSrc || garmentType !== "2d") { garmentImg.current = null; setImgReady(false); return; }
        garmentImg.current = null;
        setImgReady(false);
        smoothRef.current = {};   // reset smoothing when garment changes

        const img = new Image();
        img.onload = () => {
            if (img.naturalWidth === 0) {
                console.error("[ARTryOn] PNG loaded but has 0 width:", garmentSrc);
                return;
            }
            console.log(`[ARTryOn] Garment ready: ${img.naturalWidth}×${img.naturalHeight}px`);
            garmentImg.current = img;
            setImgReady(true);
        };
        img.onerror = () => {
            console.error(
                `[ARTryOn] Cannot load garment PNG: "${garmentSrc}"\n` +
                `Make sure the file is in your frontend/public/garments/ folder.\n` +
                `Expected path: public${garmentSrc}`
            );
            setImgReady(false);
        };
        img.src = garmentSrc;
    }, [garmentSrc, garmentType]);

    // ── Calibration ───────────────────────────────────────────────────────────
    useEffect(() => {
        if (referencePixelWidth > 0) {
            const p = calibrateFromReference(referencePixelWidth, referenceWidthCm);
            setPpcm(p);
            onCalibrated(p);
        }
    }, [referencePixelWidth, referenceWidthCm, onCalibrated]);

    useEffect(() => { measureRef.current = measurements; }, [measurements]);

    // ── Pose results ──────────────────────────────────────────────────────────
    const onPoseResults = useCallback((results) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        const W = canvas.width, H = canvas.height;
        if (!W || !H) return;

        ctx.clearRect(0, 0, W, H);

        // Draw mirrored video frame
        if (results.image) {
            ctx.save();
            ctx.translate(W, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(results.image, 0, 0, W, H);
            ctx.restore();
        }

        if (results.poseLandmarks) {
            // Mirror landmarks to match flipped video
            const lm = results.poseLandmarks.map(p => ({ ...p, x: 1 - p.x }));

            // Skeleton debug
            if (showSkeleton && window.drawConnectors && window.drawLandmarks) {
                window.drawConnectors(ctx, lm, window.POSE_CONNECTIONS, {
                    color: "rgba(0,255,170,0.5)", lineWidth: 1.5,
                });
                window.drawLandmarks(ctx, lm, {
                    color: "rgba(255,80,80,0.8)", lineWidth: 1, radius: 3,
                });
            }

            // Garment overlay
            if (garmentType === "2d") {
                const cfg = { ...DEFAULT_GARMENT_CONFIG, ...garmentConfig };
                if (imgReady && garmentImg.current) {
                    drawGarment(ctx, garmentImg.current, lm, W, H, smoothRef.current, cfg, garmentOpacity);
                } else {
                    drawFallback(ctx, lm, W, H);
                }
            }

            // Size estimation
            if (ppcm > 0) {
                const dims = estimateDimensions(lm, W, H, ppcm);
                if (dims) {
                    setMeasurements(dims);
                    onMeasurement(dims);
                }
            }

            // HUD
            if (showMeasurements && measureRef.current) {
                drawHUD(ctx, measureRef.current, W, H);
            }
        }

        trackFps();
    }, [showSkeleton, garmentType, garmentConfig, garmentOpacity, imgReady, ppcm, showMeasurements, onMeasurement, trackFps]);

    // ── Init Pose ─────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!poseReady) return;
        const pose = new window.Pose({
            locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
        });
        pose.setOptions({
            modelComplexity: 1, smoothLandmarks: true,
            enableSegmentation: false, smoothSegmentation: false,
            minDetectionConfidence: 0.55, minTrackingConfidence: 0.55,
        });
        pose.onResults(onPoseResults);
        poseRef.current = pose;
        return () => { pose.close(); poseRef.current = null; };
    }, [poseReady, onPoseResults]);

    // ── Camera ────────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!poseReady) return;
        const videoEl = videoRef.current;
        const canvas = canvasRef.current;
        if (!videoEl || !canvas) return;

        let stopped = false;

        function syncSize() {
            const w = videoEl.videoWidth || 1280;
            const h = videoEl.videoHeight || 720;
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w; canvas.height = h;
            }
        }

        async function start() {
            try {
                if (agoraLocalTrack) {
                    videoEl.srcObject = new MediaStream([agoraLocalTrack.getMediaStreamTrack()]);
                    videoEl.onloadedmetadata = syncSize;
                    await videoEl.play();
                    syncSize();
                    const loop = async () => {
                        if (stopped) return;
                        syncSize();
                        if (poseRef.current && videoEl.readyState >= 2)
                            await poseRef.current.send({ image: videoEl });
                        animFrameRef.current = requestAnimationFrame(loop);
                    };
                    animFrameRef.current = requestAnimationFrame(loop);
                } else {
                    canvas.width = 1280; canvas.height = 720;
                    const cam = new window.Camera(videoEl, {
                        onFrame: async () => {
                            if (stopped || !poseRef.current) return;
                            syncSize();
                            await poseRef.current.send({ image: videoEl });
                        },
                        width: 1280, height: 720,
                    });
                    await cam.start();
                    cameraRef.current = cam;
                }
                if (!stopped) setIsLoading(false);
            } catch (err) {
                console.error("[ARTryOn] Camera error:", err);
                if (!stopped) setLoadError(err.message);
            }
        }

        start();

        return () => {
            stopped = true;
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
            if (cameraRef.current) { cameraRef.current.stop(); cameraRef.current = null; }
            if (videoEl.srcObject) videoEl.srcObject.getTracks().forEach(t => t.stop());
        };
    }, [poseReady, agoraLocalTrack]);

    if (loadError) return (
        <div style={{ ...S.container, ...S.err }}>
            <span style={{ fontSize: 13, fontFamily: "monospace", color: "#ff6b6b" }}>
                {loadError}
            </span>
        </div>
    );

    return (
        <div style={S.container}>
            <video ref={videoRef} style={S.video} muted playsInline autoPlay />
            <canvas ref={canvasRef} style={S.canvas} />

            {(isLoading || !poseReady) && (
                <div style={S.loader}>
                    <div style={S.ring} />
                    <span style={S.loaderText}>
                        {!poseReady ? "Loading AI model…" : "Starting camera…"}
                    </span>
                </div>
            )}

            {!isLoading && <div style={S.fps}>{fps} fps</div>}

            {!isLoading && ppcm === 0 && (
                <div style={S.calibBanner}>
                    Hold a credit card flat to camera to calibrate size
                </div>
            )}

            {!isLoading && imgReady && (
                <div style={S.readyBadge}>Garment loaded</div>
            )}
        </div>
    );
}

const S = {
    container: {
        position: "relative", width: "100%", height: "100%",
        background: "#000", overflow: "hidden", borderRadius: "inherit",
    },
    video: {
        position: "absolute", left: "-9999px", top: 0,
        width: "1280px", height: "720px", visibility: "hidden",
    },
    canvas: {
        position: "absolute", inset: 0, width: "100%", height: "100%",
    },
    loader: {
        position: "absolute", inset: 0, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.8)", zIndex: 20, gap: 14,
    },
    ring: {
        width: 44, height: 44,
        border: "3px solid rgba(255,255,255,0.1)",
        borderTop: "3px solid #00ffaa",
        borderRadius: "50%", animation: "spin 0.75s linear infinite",
    },
    loaderText: { color: "rgba(255,255,255,0.7)", fontFamily: "sans-serif", fontSize: 13 },
    fps: {
        position: "absolute", top: 12, right: 12, zIndex: 30,
        background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)",
        color: "#00ffaa", fontFamily: "'SF Mono', monospace", fontSize: 11,
        padding: "3px 8px", borderRadius: 6,
        border: "1px solid rgba(0,255,170,0.2)",
    },
    calibBanner: {
        position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
        background: "rgba(255,200,0,0.95)", color: "#000",
        fontFamily: "sans-serif", fontSize: 12, fontWeight: 600,
        padding: "7px 18px", borderRadius: 20, zIndex: 30,
        whiteSpace: "nowrap", boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    },
    readyBadge: {
        position: "absolute", bottom: 20, left: 16, zIndex: 30,
        background: "rgba(0,255,170,0.15)", border: "1px solid rgba(0,255,170,0.3)",
        color: "#00ffaa", fontFamily: "sans-serif", fontSize: 11,
        padding: "4px 10px", borderRadius: 6,
    },
    err: {
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, textAlign: "center",
    },
};
