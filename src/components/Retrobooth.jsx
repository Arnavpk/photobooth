/**
 * RetroPhotobooth.jsx
 *
 * Retro photobooth with:
 *  - Automatic background removal from uploaded clothing PNGs
 *  - Smart garment fitting that auto-detects clothing bounds
 *  - 5 film filter presets with grain, vignette, light leak
 *  - 4-shot countdown sequence with shutter flash
 *  - Downloadable polaroid-style photo strip
 */

import React, { useRef, useEffect, useState, useCallback } from "react";

// ─── MediaPipe CDN ─────────────────────────────────────────────────────────────
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
        s.onerror = () => reject(new Error(`Failed: ${src}`));
        document.head.appendChild(s);
    });
}

function waitForGlobal(name, ms = 12000) {
    return new Promise((res, rej) => {
        if (typeof window[name] === "function") { res(); return; }
        let t = 0;
        const iv = setInterval(() => {
            if (typeof window[name] === "function") { clearInterval(iv); res(); }
            else if ((t += 50) > ms) { clearInterval(iv); rej(new Error(`${name} timed out`)); }
        }, 50);
    });
}

// ─── Landmark indices ──────────────────────────────────────────────────────────
const LM = { LS: 11, RS: 12, LH: 23, RH: 24, NOSE: 0 };

// ─── Film presets ──────────────────────────────────────────────────────────────
const FILTERS = [
    { id: "chrome", label: "Chrome", emoji: "✦", css: "saturate(1.3) contrast(1.15) brightness(1.05)", grain: 0.04, vignette: 0.35, leak: "rgba(255,200,100,0.07)", frame: "#f5e6c8", frameAccent: "#c8a96e", dateColor: "#8b6914" },
    { id: "kodak", label: "Kodak", emoji: "⬡", css: "sepia(0.45) saturate(1.6) contrast(1.1) brightness(1.02)", grain: 0.06, vignette: 0.45, leak: "rgba(255,150,50,0.1)", frame: "#fffbf0", frameAccent: "#e8c878", dateColor: "#d4820a" },
    { id: "ilford", label: "Ilford B&W", emoji: "◈", css: "grayscale(1) contrast(1.25) brightness(0.95)", grain: 0.09, vignette: 0.55, leak: null, frame: "#f0f0f0", frameAccent: "#888888", dateColor: "#444444" },
    { id: "lomo", label: "Lomo", emoji: "◉", css: "saturate(1.8) contrast(1.3) brightness(0.9) hue-rotate(5deg)", grain: 0.08, vignette: 0.65, leak: "rgba(80,0,255,0.06)", frame: "#ffffff", frameAccent: "#ff4444", dateColor: "#ff2200" },
    { id: "faded", label: "Faded", emoji: "◫", css: "sepia(0.2) saturate(0.7) contrast(0.9) brightness(1.15)", grain: 0.05, vignette: 0.25, leak: "rgba(200,180,255,0.08)", frame: "#faf8ff", frameAccent: "#b8a9cc", dateColor: "#7a6a99" },
];

// ══════════════════════════════════════════════════════════════════════════════
// BACKGROUND REMOVAL ENGINE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * removeBackground(img) → Promise<HTMLCanvasElement>
 *
 * Multi-pass background removal:
 *  Pass 1 — Sample background color from the 4 corners + thin edge strip
 *  Pass 2 — Flood-fill from all 4 corners removing pixels within tolerance
 *  Pass 3 — Edge-aware cleanup: remove isolated near-background fringe pixels
 *  Pass 4 — Feather alpha at remaining edges for smooth compositing
 *
 * Works on: white bg, off-white, light grey, solid color studio shots,
 *           any reasonably uniform background.
 */
async function removeBackground(img) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;

    // Offscreen canvas
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);

    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;  // RGBA flat array

    // ── Helper: pixel index ──────────────────────────────────────────────────
    const idx = (x, y) => (y * W + x) * 4;

    // ── Helper: color distance (Euclidean in RGB) ────────────────────────────
    const colorDist = (i, r, g, b) =>
        Math.sqrt(
            (d[i] - r) ** 2 +
            (d[i + 1] - g) ** 2 +
            (d[i + 2] - b) ** 2
        );

    // ── Pass 1: Sample background color from corners + edge strip ────────────
    // Collect ~200 sample pixels from corners and edges, find dominant color.
    const samples = [];
    const edgeSampleDepth = Math.max(3, Math.floor(Math.min(W, H) * 0.025));

    // Corners (5×5 patch each)
    for (let cy = 0; cy < edgeSampleDepth; cy++) {
        for (let cx = 0; cx < edgeSampleDepth; cx++) {
            const corners = [
                [cx, cy],
                [W - 1 - cx, cy],
                [cx, H - 1 - cy],
                [W - 1 - cx, H - 1 - cy],
            ];
            for (const [x, y] of corners) {
                if (x < 0 || x >= W || y < 0 || y >= H) continue;
                const i = idx(x, y);
                if (d[i + 3] < 128) continue; // skip already transparent
                samples.push([d[i], d[i + 1], d[i + 2]]);
            }
        }
    }

    if (samples.length === 0) return canvas; // fully transparent already

    // Average the most common-ish corner samples (trim outliers)
    samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    const mid = samples.slice(
        Math.floor(samples.length * 0.1),
        Math.floor(samples.length * 0.9)
    );
    const bgR = Math.round(mid.reduce((s, c) => s + c[0], 0) / mid.length);
    const bgG = Math.round(mid.reduce((s, c) => s + c[1], 0) / mid.length);
    const bgB = Math.round(mid.reduce((s, c) => s + c[2], 0) / mid.length);

    // ── Adaptive tolerance: looser for near-white/near-black backgrounds ─────
    const bgBrightness = (bgR + bgG + bgB) / 3;
    const BASE_TOLERANCE = 38;
    const tolerance = bgBrightness > 200 || bgBrightness < 30
        ? BASE_TOLERANCE + 20   // white/black bg: be more aggressive
        : BASE_TOLERANCE;

    // ── Pass 2: Multi-seed flood-fill from all edges ──────────────────────────
    // Uses iterative BFS (stack) instead of recursion to avoid stack overflow.
    const removed = new Uint8Array(W * H); // 1 = should be transparent

    function floodFill(startX, startY) {
        const stack = [[startX, startY]];
        while (stack.length > 0) {
            const [x, y] = stack.pop();
            if (x < 0 || x >= W || y < 0 || y >= H) continue;
            const flat = y * W + x;
            if (removed[flat]) continue;
            const i = idx(x, y);
            if (d[i + 3] < 10) { removed[flat] = 1; continue; } // already clear
            if (colorDist(i, bgR, bgG, bgB) > tolerance) continue;
            removed[flat] = 1;
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
    }

    // Seed from all 4 edges
    for (let x = 0; x < W; x++) { floodFill(x, 0); floodFill(x, H - 1); }
    for (let y = 0; y < H; y++) { floodFill(0, y); floodFill(W - 1, y); }

    // ── Pass 3: Fringe cleanup ────────────────────────────────────────────────
    // Any kept pixel that has 3+ neighbours removed and is within 1.5x tolerance
    // is likely a fringe/shadow remnant — remove it.
    const fringeRemoved = new Uint8Array(W * H);
    const FRINGE_TOLERANCE = tolerance * 1.5;

    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const flat = y * W + x;
            if (removed[flat]) continue;
            const i = idx(x, y);
            if (d[i + 3] < 128) continue;
            if (colorDist(i, bgR, bgG, bgB) > FRINGE_TOLERANCE) continue;

            // Count removed neighbours
            let removedNeighbours = 0;
            for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1], [x + 1, y + 1], [x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1]]) {
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) { removedNeighbours++; continue; }
                if (removed[ny * W + nx] || fringeRemoved[ny * W + nx]) removedNeighbours++;
            }
            if (removedNeighbours >= 4) fringeRemoved[flat] = 1;
        }
    }

    // ── Apply removals + edge feathering ──────────────────────────────────────
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const flat = y * W + x;
            const i = flat * 4;

            if (removed[flat] || fringeRemoved[flat]) {
                d[i + 3] = 0;
                continue;
            }

            // ── Pass 4: feather alpha at kept-pixel edges ──────────────────────
            // If a kept pixel is adjacent to removed pixels, soften its alpha.
            if (d[i + 3] > 0) {
                let adjRemoved = 0, total = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx, ny = y + dy;
                        total++;
                        if (nx < 0 || nx >= W || ny < 0 || ny >= H) { adjRemoved++; continue; }
                        const nf = ny * W + nx;
                        if (removed[nf] || fringeRemoved[nf]) adjRemoved++;
                    }
                }
                if (adjRemoved > 0) {
                    // Feather: the more removed neighbours, the more we fade
                    const featherFactor = 1 - (adjRemoved / total) * 0.7;
                    d[i + 3] = Math.floor(d[i + 3] * featherFactor);
                }
            }
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

// ══════════════════════════════════════════════════════════════════════════════
// GARMENT CONTENT CROP
// After background removal, crops the canvas to the tight pixel bounding box
// and returns a new canvas containing ONLY the clothing pixels.
// Also computes the shoulder-line position within the cropped image.
// ══════════════════════════════════════════════════════════════════════════════
function cropGarmentToContent(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const W = canvas.width, H = canvas.height;
    const data = ctx.getImageData(0, 0, W, H).data;

    // ── Find tight bounding box of opaque pixels ──────────────────────────────
    let top = H, bottom = 0, left = W, right = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (data[(y * W + x) * 4 + 3] > 16) {
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
            }
        }
    }

    if (left > right || top > bottom) return null;

    const cW = right - left + 1;
    const cH = bottom - top + 1;

    // ── Copy just the content region to a new canvas ──────────────────────────
    const cropped = document.createElement("canvas");
    cropped.width = cW;
    cropped.height = cH;
    cropped.getContext("2d").drawImage(canvas, left, top, cW, cH, 0, 0, cW, cH);

    // ── Detect shoulder line within the CROPPED canvas ────────────────────────
    // Strategy: scan rows from the top of the cropped image.
    // The shoulder line is the first row where the garment spans its WIDEST
    // horizontal extent — that is typically the shoulder/upper-chest area.
    // We look for the row with maximum opaque pixel spread in the top 40%.
    const ctx2 = cropped.getContext("2d", { willReadFrequently: true });
    const cd = ctx2.getImageData(0, 0, cW, cH).data;
    const scanH = Math.floor(cH * 0.40); // only scan top 40%

    let shoulderRow = Math.floor(cH * 0.12); // fallback: 12% from top
    let maxSpread = 0;

    for (let y = 0; y < scanH; y++) {
        let rowLeft = cW, rowRight = 0;
        for (let x = 0; x < cW; x++) {
            if (cd[(y * cW + x) * 4 + 3] > 30) {
                if (x < rowLeft) rowLeft = x;
                if (x > rowRight) rowRight = x;
            }
        }
        const spread = rowLeft < rowRight ? (rowRight - rowLeft) : 0;
        if (spread > maxSpread) {
            maxSpread = spread;
            shoulderRow = y;
        }
    }

    // ── Auto-compute shoulder width ratio ─────────────────────────────────────
    // How wide is the shoulder row relative to the full content width?
    // This lets us compute: targetW = bodyShoulderPx / shoulderWidthRatio
    const shoulderWidthRatio = maxSpread > 0 ? maxSpread / cW : 0.72;

    return {
        canvas: cropped,
        contentW: cW,
        contentH: cH,
        // shoulderRow: pixel Y in the cropped canvas where shoulders sit
        shoulderRow,
        // shoulderWidthRatio: fraction of contentW that is the shoulder span
        shoulderWidthRatio: Math.min(0.98, Math.max(0.3, shoulderWidthRatio)),
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// GARMENT DRAWING — body-aware scaling from cropped content
//
// The algorithm:
//   1. body shoulder width (px) is known from MediaPipe
//   2. garment shoulder width = contentW * shoulderWidthRatio
//   3. scale = bodyShoulderPx / garmentShoulderPx  →  targetW = contentW * scale
//   4. targetH = contentH * scale  (preserves aspect ratio)
//   5. anchor: draw so that row[shoulderRow] in the image aligns with sm (shoulder midpoint)
//   6. rotate by shoulder tilt angle
//   7. EMA smooth all values to eliminate jitter
// ══════════════════════════════════════════════════════════════════════════════
const smooth = { x: undefined, y: undefined, w: undefined, h: undefined, a: undefined };
const ALPHA = 0.18;

function lerp(a, b, t) { return a + (b - a) * t; }

function drawGarmentOnCanvas(ctx, garmentInfo, lm, W, H, opacity = 0.95) {
    if (!garmentInfo || !lm) return;

    const { canvas: gCanvas, contentW, contentH, shoulderRow, shoulderWidthRatio } = garmentInfo;

    const ls = { x: lm[LM.LS].x * W, y: lm[LM.LS].y * H };
    const rs = { x: lm[LM.RS].x * W, y: lm[LM.RS].y * H };

    const lsVis = lm[LM.LS].visibility ?? 1;
    const rsVis = lm[LM.RS].visibility ?? 1;
    if (lsVis < 0.3 || rsVis < 0.3) return;

    const bodyShoulderPx = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    if (bodyShoulderPx < 30) return; // person too far or not detected

    const shoulderAngle = Math.atan2(rs.y - ls.y, rs.x - ls.x);
    const sm = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };

    // ── Scale the garment so its shoulder span matches the body ───────────────
    // garmentShoulderPx = contentW * shoulderWidthRatio
    // scale factor = bodyShoulderPx / garmentShoulderPx
    const garmentShoulderPx = contentW * shoulderWidthRatio;
    const scale = bodyShoulderPx / garmentShoulderPx;
    const targetW = contentW * scale;
    const targetH = contentH * scale;

    // ── Anchor: the shoulder row in the garment image aligns with sm ──────────
    // In the rotated/translated frame, origin is at sm.
    // We want row[shoulderRow] to be at y=0 (i.e. at sm).
    // So we draw the image at y = -(shoulderRow * scale) from the anchor.
    const scaledShoulderY = shoulderRow * scale;

    // anchorX: center the image horizontally on the shoulder midpoint
    const anchorX = sm.x;
    const anchorY = sm.y - scaledShoulderY;

    // ── EMA smoothing ─────────────────────────────────────────────────────────
    if (smooth.x === undefined) {
        smooth.x = anchorX; smooth.y = anchorY;
        smooth.w = targetW; smooth.h = targetH; smooth.a = shoulderAngle;
    } else {
        smooth.x = lerp(smooth.x, anchorX, ALPHA);
        smooth.y = lerp(smooth.y, anchorY, ALPHA);
        smooth.w = lerp(smooth.w, targetW, ALPHA);
        smooth.h = lerp(smooth.h, targetH, ALPHA);
        smooth.a = lerp(smooth.a, shoulderAngle, ALPHA);
    }

    // ── Draw ──────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = opacity;
    // Translate to shoulder midpoint, rotate by shoulder tilt
    ctx.translate(smooth.x, smooth.y);
    ctx.rotate(smooth.a);
    // Draw so the image is centred horizontally and shoulder row is at origin
    ctx.drawImage(gCanvas, -smooth.w / 2, 0, smooth.w, smooth.h);
    ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// RETRO EFFECTS
// ══════════════════════════════════════════════════════════════════════════════

function applyGrain(ctx, W, H, intensity) {
    if (intensity <= 0) return;
    const d = ctx.getImageData(0, 0, W, H);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
        const n = (Math.random() - 0.5) * intensity * 255;
        px[i] = Math.min(255, Math.max(0, px[i] + n));
        px[i + 1] = Math.min(255, Math.max(0, px[i + 1] + n));
        px[i + 2] = Math.min(255, Math.max(0, px[i + 2] + n));
    }
    ctx.putImageData(d, 0, 0);
}

function applyVignette(ctx, W, H, strength) {
    const cx = W / 2, cy = H / 2;
    const r = Math.sqrt(cx * cx + cy * cy);
    const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
}

function applyLightLeak(ctx, W, H, color) {
    if (!color) return;
    const g = ctx.createLinearGradient(0, 0, W * 0.4, H * 0.3);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
}


// ══════════════════════════════════════════════════════════════════════════════
// THEMED FRAMES — each has a drawFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP)
// that decorates the photo strip canvas AFTER photos are drawn.
// ══════════════════════════════════════════════════════════════════════════════

const FRAMES = [
    { id: "none", label: "Classic", emoji: "◻" },
    { id: "valentine", label: "Valentine", emoji: "♡" },
    { id: "halloween", label: "Halloween", emoji: "◈" },
    { id: "diwali", label: "Diwali", emoji: "✦" },
    { id: "eid", label: "Eid", emoji: "☽" },
    { id: "xmas", label: "Christmas", emoji: "❄" },
    { id: "beach", label: "Beach Day", emoji: "◎" },
];

function drawFrame(ctx, frameId, STRIP_W, STRIP_H, PAD, FW, FH, GAP) {
    switch (frameId) {
        case "valentine": drawValentineFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        case "halloween": drawHalloweenFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        case "diwali": drawDiwaliFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        case "eid": drawEidFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        case "xmas": drawXmasFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        case "beach": drawBeachFrame(ctx, STRIP_W, STRIP_H, PAD, FW, FH, GAP); break;
        default: break;
    }
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function heart(ctx, cx, cy, size) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, size * 0.3);
    ctx.bezierCurveTo(0, 0, -size, 0, -size, -size * 0.3);
    ctx.bezierCurveTo(-size, -size * 0.8, 0, -size * 0.8, 0, -size * 0.3);
    ctx.bezierCurveTo(0, -size * 0.8, size, -size * 0.8, size, -size * 0.3);
    ctx.bezierCurveTo(size, 0, 0, 0, 0, size * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function star5(ctx, cx, cy, r, r2, points = 5) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const rad = i % 2 === 0 ? r : r2;
        i === 0 ? ctx.moveTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad)
            : ctx.lineTo(cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad);
    }
    ctx.closePath();
    ctx.fill();
}

function crescent(ctx, cx, cy, R, offsetX, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath(); ctx.arc(cx + offsetX, cy, R * 0.78, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
}

function diya(ctx, cx, cy, size) {
    // flame
    ctx.fillStyle = "#FFD700";
    ctx.beginPath();
    ctx.ellipse(cx, cy - size * 0.6, size * 0.18, size * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#FF6600";
    ctx.beginPath();
    ctx.ellipse(cx, cy - size * 0.5, size * 0.1, size * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    // bowl
    ctx.fillStyle = "#C0622A";
    ctx.beginPath();
    ctx.ellipse(cx, cy, size * 0.38, size * 0.2, 0, 0, Math.PI);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.38, cy);
    ctx.lineTo(cx - size * 0.15, cy + size * 0.35);
    ctx.lineTo(cx + size * 0.15, cy + size * 0.35);
    ctx.lineTo(cx + size * 0.38, cy);
    ctx.closePath();
    ctx.fill();
}

function snowflake(ctx, cx, cy, r) {
    ctx.save(); ctx.translate(cx, cy);
    for (let i = 0; i < 6; i++) {
        ctx.save(); ctx.rotate((i * Math.PI) / 3);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, r);
        ctx.moveTo(0, r * 0.3); ctx.lineTo(-r * 0.2, r * 0.5);
        ctx.moveTo(0, r * 0.3); ctx.lineTo(r * 0.2, r * 0.5);
        ctx.moveTo(0, r * 0.65); ctx.lineTo(-r * 0.18, r * 0.82);
        ctx.moveTo(0, r * 0.65); ctx.lineTo(r * 0.18, r * 0.82);
        ctx.stroke(); ctx.restore();
    }
    ctx.restore();
}

function pumpkin(ctx, cx, cy, size) {
    // body segments
    const cols = ["#E05C00", "#D94E00", "#E86800", "#D45500", "#EB6C00"];
    for (let i = -2; i <= 2; i++) {
        ctx.fillStyle = cols[i + 2];
        ctx.beginPath();
        ctx.ellipse(cx + i * size * 0.22, cy + size * 0.1, size * 0.28, size * 0.38, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    // stem
    ctx.fillStyle = "#2D4A1E";
    ctx.beginPath(); ctx.roundRect(cx - size * 0.06, cy - size * 0.42, size * 0.12, size * 0.2, 2); ctx.fill();
    // face
    ctx.fillStyle = "#1a0a00";
    // eyes
    ctx.beginPath(); ctx.moveTo(cx - size * 0.28, cy - size * 0.06);
    ctx.lineTo(cx - size * 0.18, cy - size * 0.16); ctx.lineTo(cx - size * 0.08, cy - size * 0.06); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + size * 0.08, cy - size * 0.06);
    ctx.lineTo(cx + size * 0.18, cy - size * 0.16); ctx.lineTo(cx + size * 0.28, cy - size * 0.06); ctx.fill();
    // smile
    ctx.beginPath(); ctx.arc(cx, cy + size * 0.1, size * 0.22, 0.2, Math.PI - 0.2); ctx.fill();
}

function palmTree(ctx, cx, cy, size) {
    // trunk
    ctx.strokeStyle = "#8B5E3C"; ctx.lineWidth = size * 0.12;
    ctx.beginPath();
    ctx.moveTo(cx, cy + size);
    ctx.bezierCurveTo(cx + size * 0.1, cy + size * 0.4, cx - size * 0.1, cy, cx, cy - size * 0.2);
    ctx.stroke();
    // fronds
    const fronds = [[-0.8, 0.1], [-0.4, -0.4], [0.1, -0.5], [0.5, -0.3], [0.8, 0.2]];
    fronds.forEach(([dx, dy]) => {
        ctx.strokeStyle = "#2E8B57"; ctx.lineWidth = size * 0.07;
        ctx.beginPath();
        ctx.moveTo(cx, cy - size * 0.2);
        ctx.quadraticCurveTo(
            cx + dx * size * 0.6, cy + dy * size * 0.4,
            cx + dx * size, cy + dy * size * 0.8
        );
        ctx.stroke();
    });
    // coconuts
    ctx.fillStyle = "#6B3A2A";
    [[0.12, -0.28], [-0.1, -0.3], [0.02, -0.4]].forEach(([dx, dy]) => {
        ctx.beginPath(); ctx.arc(cx + dx * size, cy + dy * size, size * 0.07, 0, Math.PI * 2); ctx.fill();
    });
}

function wave(ctx, x, y, W, amplitude, freq, color, alpha = 0.6) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let px = 0; px <= W; px += 4) {
        ctx.lineTo(x + px, y + Math.sin((px / W) * Math.PI * freq) * amplitude);
    }
    ctx.stroke(); ctx.restore();
}

function starShape4(ctx, cx, cy, size, color) {
    ctx.fillStyle = color;
    ctx.save(); ctx.translate(cx, cy);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const angle = (i * Math.PI) / 4;
        const r = i % 2 === 0 ? size : size * 0.38;
        i === 0 ? ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r)
            : ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
}

// ── VALENTINE ─────────────────────────────────────────────────────────────────
function drawValentineFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    const seed = [
        [12, 18, 14, "#FF3366", 0.9], [SW - 14, 22, 10, "#FF6688", 0.8],
        [8, SH * 0.25, 9, "#FF3366", 0.7], [SW - 10, SH * 0.22, 12, "#FF1144", 0.85],
        [14, SH * 0.5, 11, "#FF6688", 0.75], [SW - 12, SH * 0.5, 8, "#FF3366", 0.8],
        [10, SH * 0.75, 10, "#FF1144", 0.9], [SW - 11, SH * 0.75, 13, "#FF6688", 0.75],
        [12, SH - 20, 9, "#FF3366", 0.8], [SW - 14, SH - 18, 11, "#FF1144", 0.9],
        // scattered smalls
        [30, 40, 6, "#FF88AA", 0.5], [SW - 30, 50, 5, "#FF3366", 0.4],
        [20, SH * 0.35, 5, "#FF1144", 0.5], [SW - 20, SH * 0.38, 6, "#FF88AA", 0.45],
        [25, SH * 0.62, 7, "#FF3366", 0.55], [SW - 25, SH * 0.6, 5, "#FF1144", 0.5],
        [18, SH * 0.88, 5, "#FF88AA", 0.4], [SW - 18, SH * 0.88, 6, "#FF3366", 0.45],
    ];
    seed.forEach(([cx, cy, size, color, alpha]) => {
        ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color;
        heart(ctx, cx, cy, size); ctx.restore();
    });
    // border
    ctx.save();
    ctx.strokeStyle = "#FF3366"; ctx.lineWidth = 3; ctx.globalAlpha = 0.6;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(4, 4, SW - 8, SH - 8);
    ctx.setLineDash([]); ctx.restore();
    // between-photo dividers
    for (let i = 0; i < 3; i++) {
        const divY = PAD + (FH + GAP) * (i + 1) - GAP / 2;
        ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "#FF3366";
        [-30, -15, 0, 15, 30].forEach(dx => heart(ctx, SW / 2 + dx, divY, 4));
        ctx.restore();
    }
    // label background
    const ly = SH - 56;
    ctx.save();
    const lg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    lg.addColorStop(0, "rgba(255,51,102,0.3)"); lg.addColorStop(1, "rgba(255,136,170,0.2)");
    ctx.fillStyle = lg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
}

// ── HALLOWEEN ─────────────────────────────────────────────────────────────────
function drawHalloweenFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    // dark purple wash on borders
    ctx.save(); ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#1a0030";
    ctx.fillRect(0, 0, PAD + 4, SH); ctx.fillRect(SW - PAD - 4, 0, PAD + 4, SH);
    ctx.fillRect(0, 0, SW, PAD + 4); ctx.fillRect(0, SH - PAD - 4, SW, PAD + 4);
    ctx.restore();
    // bats
    const bats = [
        [16, 24], [SW - 20, 28], [14, SH * 0.28], [SW - 16, SH * 0.32],
        [18, SH * 0.55], [SW - 18, SH * 0.58], [15, SH * 0.8], [SW - 20, SH * 0.83],
        [12, SH - 30], [SW - 14, SH - 26],
    ];
    bats.forEach(([bx, by]) => {
        ctx.save(); ctx.fillStyle = "#220040"; ctx.globalAlpha = 0.85;
        ctx.translate(bx, by);
        // bat body
        ctx.beginPath(); ctx.ellipse(0, 0, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
        // wings
        ctx.beginPath(); ctx.moveTo(0, -1);
        ctx.bezierCurveTo(-4, -6, -12, -4, -12, 2);
        ctx.bezierCurveTo(-8, 0, -4, 2, 0, 1);
        ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, -1);
        ctx.bezierCurveTo(4, -6, 12, -4, 12, 2);
        ctx.bezierCurveTo(8, 0, 4, 2, 0, 1);
        ctx.fill();
        ctx.restore();
    });
    // pumpkins at corners
    [[PAD / 2, PAD / 2], [SW - PAD * 1.2, PAD / 2], [PAD / 2, SH - PAD * 1.5], [SW - PAD * 1.2, SH - PAD * 1.5]].forEach(([px, py]) => {
        ctx.save(); ctx.globalAlpha = 0.9; pumpkin(ctx, px + 10, py + 12, 14); ctx.restore();
    });
    // spider webs in corners (arcs)
    [[0, 0, 1, 1], [SW, 0, -1, 1], [0, SH, 1, -1], [SW, SH, -1, -1]].forEach(([wx, wy, dx, dy]) => {
        ctx.save(); ctx.strokeStyle = "rgba(200,180,255,0.35)"; ctx.lineWidth = 0.8;
        [20, 35, 50].forEach(r => {
            ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI / 2); ctx.stroke();
        });
        for (let a = 0; a <= Math.PI / 2; a += Math.PI / 8) {
            ctx.beginPath(); ctx.moveTo(wx, wy);
            ctx.lineTo(wx + dx * 50 * Math.cos(a), wy + dy * 50 * Math.sin(a)); ctx.stroke();
        }
        ctx.restore();
    });
    // label bg
    const ly = SH - 56;
    ctx.save();
    const lg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    lg.addColorStop(0, "rgba(30,0,60,0.7)"); lg.addColorStop(1, "rgba(80,0,40,0.5)");
    ctx.fillStyle = lg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
    // glowing orange border
    ctx.save(); ctx.strokeStyle = "#FF6600"; ctx.lineWidth = 2; ctx.globalAlpha = 0.5;
    ctx.shadowColor = "#FF6600"; ctx.shadowBlur = 8;
    ctx.strokeRect(5, 5, SW - 10, SH - 10); ctx.restore();
}

// ── DIWALI ────────────────────────────────────────────────────────────────────
function drawDiwaliFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    // rich gold border gradient
    const bg = ctx.createLinearGradient(0, 0, SW, SH);
    bg.addColorStop(0, "#3D1C00"); bg.addColorStop(0.5, "#1A0A00"); bg.addColorStop(1, "#2E1400");
    ctx.save(); ctx.globalAlpha = 0.7;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, PAD + 6, SH); ctx.fillRect(SW - PAD - 6, 0, PAD + 6, SH);
    ctx.fillRect(0, 0, SW, PAD + 6); ctx.fillRect(0, SH - PAD - 6, SW, PAD + 6);
    ctx.restore();
    // diyas at corners + sides
    [[PAD * .6, PAD * .7], [SW - PAD * .8, PAD * .7],
    [PAD * .6, SH * 0.25], [SW - PAD * .8, SH * 0.25],
    [PAD * .6, SH * 0.5], [SW - PAD * .8, SH * 0.5],
    [PAD * .6, SH * 0.75], [SW - PAD * .8, SH * 0.75],
    [PAD * .6, SH - PAD * .9], [SW - PAD * .8, SH - PAD * .9]
    ].forEach(([dx, dy]) => { ctx.save(); ctx.globalAlpha = 0.95; diya(ctx, dx, dy, 13); ctx.restore(); });
    // gold stars scattered
    const starPositions = [
        [30, 35], [SW - 30, 40], [22, SH * .37], [SW - 22, SH * .38],
        [26, SH * .63], [SW - 26, SH * .65], [28, SH * .9], [SW - 28, SH * .88],
    ];
    starPositions.forEach(([sx, sy]) => {
        ctx.save(); ctx.globalAlpha = 0.7; ctx.fillStyle = "#FFD700";
        star5(ctx, sx, sy, 6, 3); ctx.restore();
        ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = "#FFF8DC";
        star5(ctx, sx + 8, sy - 4, 3, 1.5); ctx.restore();
    });
    // rangoli dots between photos
    for (let i = 0; i < 3; i++) {
        const divY = PAD + (FH + GAP) * (i + 1) - GAP / 2;
        const colors = ["#FF6600", "#FFD700", "#FF3300", "#FFAA00", "#FF6600"];
        colors.forEach((c, ci) => {
            ctx.save(); ctx.fillStyle = c; ctx.globalAlpha = 0.7;
            ctx.beginPath(); ctx.arc(SW / 2 + (ci - 2) * 14, divY, 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        });
    }
    // ornate gold border
    ctx.save(); ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.7;
    ctx.shadowColor = "#FFD700"; ctx.shadowBlur = 6;
    ctx.strokeRect(4, 4, SW - 8, SH - 8);
    ctx.lineWidth = 0.8; ctx.globalAlpha = 0.4;
    ctx.strokeRect(8, 8, SW - 16, SH - 16); ctx.restore();
    // label bg
    const ly = SH - 56;
    const llg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    llg.addColorStop(0, "rgba(80,30,0,0.75)"); llg.addColorStop(1, "rgba(50,20,0,0.6)");
    ctx.save(); ctx.fillStyle = llg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
}

// ── EID ───────────────────────────────────────────────────────────────────────
function drawEidFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    // teal/emerald border wash
    ctx.save(); ctx.globalAlpha = 0.5;
    const bg2 = ctx.createLinearGradient(0, 0, 0, SH);
    bg2.addColorStop(0, "#003322"); bg2.addColorStop(1, "#001A11");
    ctx.fillStyle = bg2;
    ctx.fillRect(0, 0, PAD + 5, SH); ctx.fillRect(SW - PAD - 5, 0, PAD + 5, SH);
    ctx.fillRect(0, 0, SW, PAD + 5); ctx.fillRect(0, SH - PAD - 5, SW, PAD + 5);
    ctx.restore();
    // crescents + stars
    const eidElems = [
        [14, 22], [SW - 16, 20], [12, SH * 0.3], [SW - 15, SH * 0.32],
        [13, SH * 0.55], [SW - 14, SH * 0.57], [12, SH * 0.8], [SW - 15, SH * 0.82],
        [14, SH - 28], [SW - 16, SH - 26],
    ];
    eidElems.forEach(([ex, ey], ei) => {
        // crescent
        ctx.save();
        crescent(ctx, ex, ey, 11, 7, "#FFD700");
        ctx.restore();
        // star next to crescent
        ctx.save(); ctx.fillStyle = "#FFD700"; ctx.globalAlpha = 0.9;
        star5(ctx, ex + 14, ey - 8, 5, 2);
        ctx.restore();
    });
    // geometric arabesque pattern on border (repeated diamond motif)
    ctx.save(); ctx.strokeStyle = "rgba(0,200,120,0.25)"; ctx.lineWidth = 0.8;
    for (let y = PAD + 20; y < SH - PAD; y += 28) {
        // left border diamonds
        const lx = PAD / 2;
        ctx.beginPath(); ctx.moveTo(lx, y - 9); ctx.lineTo(lx + 6, y); ctx.lineTo(lx, y + 9); ctx.lineTo(lx - 6, y); ctx.closePath(); ctx.stroke();
        // right border diamonds
        const rx = SW - PAD / 2;
        ctx.beginPath(); ctx.moveTo(rx, y - 9); ctx.lineTo(rx + 6, y); ctx.lineTo(rx, y + 9); ctx.lineTo(rx - 6, y); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
    // dividers
    for (let i = 0; i < 3; i++) {
        const divY = PAD + (FH + GAP) * (i + 1) - GAP / 2;
        ctx.save(); ctx.strokeStyle = "rgba(255,215,0,0.5)"; ctx.lineWidth = 0.8;
        ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD, divY); ctx.lineTo(PAD + FW, divY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#FFD700"; ctx.globalAlpha = 0.8;
        star5(ctx, SW / 2, divY, 5, 2);
        ctx.restore();
    }
    // border
    ctx.save(); ctx.strokeStyle = "#00CC77"; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.7;
    ctx.shadowColor = "#00FF88"; ctx.shadowBlur = 5;
    ctx.strokeRect(4, 4, SW - 8, SH - 8); ctx.restore();
    // label
    const ly = SH - 56;
    const llg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    llg.addColorStop(0, "rgba(0,60,30,0.7)"); llg.addColorStop(1, "rgba(0,40,20,0.55)");
    ctx.save(); ctx.fillStyle = llg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
}

// ── CHRISTMAS ─────────────────────────────────────────────────────────────────
function drawXmasFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    // deep forest green border
    ctx.save(); ctx.globalAlpha = 0.65;
    ctx.fillStyle = "#071A08";
    ctx.fillRect(0, 0, PAD + 5, SH); ctx.fillRect(SW - PAD - 5, 0, PAD + 5, SH);
    ctx.fillRect(0, 0, SW, PAD + 5); ctx.fillRect(0, SH - PAD - 5, SW, PAD + 5);
    ctx.restore();
    // snowflakes
    const flakePos = [
        [14, 18, 9], [SW - 16, 22, 8], [10, SH * .26, 7], [SW - 12, SH * .28, 9],
        [12, SH * .52, 8], [SW - 14, SH * .54, 7], [11, SH * .78, 9], [SW - 13, SH * .8, 8],
        [14, SH - 24, 7], [SW - 16, SH - 22, 9],
        [30, 35, 4], [SW - 30, 40, 4], [22, SH * .4, 3], [SW - 22, SH * .42, 3],
        [28, SH * .66, 4], [SW - 28, SH * .68, 3], [24, SH * .9, 3], [SW - 24, SH * .88, 4],
    ];
    flakePos.forEach(([fx, fy, fr]) => {
        ctx.save(); ctx.strokeStyle = "#CCE8FF"; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
        snowflake(ctx, fx, fy, fr); ctx.restore();
    });
    // baubles / ornaments on the border
    const baubles = [
        [PAD * .5, SH * .15, "#FF3333"], [SW - PAD * .5, SH * .12, "#FFD700"],
        [PAD * .5, SH * .38, "#FFD700"], [SW - PAD * .5, SH * .4, "#CC0000"],
        [PAD * .5, SH * .62, "#CC0000"], [SW - PAD * .5, SH * .65, "#FF3333"],
        [PAD * .5, SH * .85, "#FFD700"], [SW - PAD * .5, SH * .88, "#CC0000"],
    ];
    baubles.forEach(([bx, by, bc]) => {
        ctx.save();
        ctx.fillStyle = "#3A7D44"; ctx.globalAlpha = 0.9;
        ctx.fillRect(bx - 1, by - 10, 2, 8);
        ctx.fillStyle = bc; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath(); ctx.arc(bx - 2, by - 2, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    });
    // holly berries + leaves at corners
    [[PAD / 2, PAD / 2], [SW - PAD * 1.1, PAD / 2], [PAD / 2, SH - PAD * 1.1], [SW - PAD * 1.1, SH - PAD * 1.1]].forEach(([hx, hy]) => {
        ctx.save(); ctx.fillStyle = "#1A5C28"; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.ellipse(hx, hy, 9, 5, -0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(hx + 8, hy + 4, 9, 5, 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#CC0000";
        [[hx + 3, hy - 2], [hx + 8, hy + 1], [hx + 4, hy + 3]].forEach(([rx, ry]) => { ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill(); });
        ctx.restore();
    });
    // dividers with stars
    for (let i = 0; i < 3; i++) {
        const divY = PAD + (FH + GAP) * (i + 1) - GAP / 2;
        ctx.save(); ctx.strokeStyle = "rgba(200,240,200,0.3)"; ctx.lineWidth = 0.8;
        ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(PAD, divY); ctx.lineTo(PAD + FW, divY); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#FFD700"; ctx.globalAlpha = 0.9;
        star5(ctx, SW / 2, divY, 7, 3); ctx.restore();
    }
    // border
    ctx.save(); ctx.strokeStyle = "#CC0000"; ctx.lineWidth = 3; ctx.globalAlpha = 0.7;
    ctx.strokeRect(4, 4, SW - 8, SH - 8);
    ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 1; ctx.globalAlpha = 0.4;
    ctx.strokeRect(8, 8, SW - 16, SH - 16); ctx.restore();
    // label
    const ly = SH - 56;
    const llg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    llg.addColorStop(0, "rgba(10,40,15,0.75)"); llg.addColorStop(1, "rgba(5,25,8,0.6)");
    ctx.save(); ctx.fillStyle = llg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
}

// ── BEACH ─────────────────────────────────────────────────────────────────────
function drawBeachFrame(ctx, SW, SH, PAD, FW, FH, GAP) {
    // sandy border
    ctx.save(); ctx.globalAlpha = 0.75;
    const bg3 = ctx.createLinearGradient(0, 0, 0, SH);
    bg3.addColorStop(0, "#E8D5A0"); bg3.addColorStop(0.6, "#D4C090"); bg3.addColorStop(1, "#C8B07A");
    ctx.fillStyle = bg3;
    ctx.fillRect(0, 0, PAD + 5, SH); ctx.fillRect(SW - PAD - 5, 0, PAD + 5, SH);
    ctx.fillRect(0, 0, SW, PAD + 8); ctx.fillRect(0, SH - PAD - 8, SW, PAD + 8);
    ctx.restore();
    // sky gradient top band
    ctx.save(); ctx.globalAlpha = 0.5;
    const sky = ctx.createLinearGradient(0, 0, 0, PAD + 8);
    sky.addColorStop(0, "#87CEEB"); sky.addColorStop(1, "rgba(135,206,235,0)");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, SW, PAD + 8); ctx.restore();
    // palm trees at corners
    [[PAD * .6, PAD + 10, 18], [SW - PAD * .8, PAD + 10, 15],
    [PAD * .6, SH * 0.5, 14], [SW - PAD * .8, SH * 0.52, 16]].forEach(([px, py, ps]) => {
        ctx.save(); ctx.globalAlpha = 0.85; palmTree(ctx, px, py, ps); ctx.restore();
    });
    // waves at bottom
    wave(ctx, 0, SH - PAD + 2, SW, 4, 3, "#1E90FF", 0.4);
    wave(ctx, 0, SH - PAD + 7, SW, 3, 4, "#00BFFF", 0.35);
    wave(ctx, 0, SH - PAD + 12, SW, 2.5, 5, "#87CEEB", 0.3);
    // suns top corners
    [[18, 16], [SW - 18, 16]].forEach(([sx, sy]) => {
        ctx.save(); ctx.fillStyle = "#FFD700"; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
        // rays
        ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 1.5;
        for (let r = 0; r < 8; r++) {
            const a = (r * Math.PI) / 4;
            ctx.beginPath();
            ctx.moveTo(sx + Math.cos(a) * 10, sy + Math.sin(a) * 10);
            ctx.lineTo(sx + Math.cos(a) * 15, sy + Math.sin(a) * 15);
            ctx.stroke();
        }
        ctx.restore();
    });
    // seashells / starfish on border
    const shells = [
        [PAD * .5, SH * .28, "#F4A460"], [SW - PAD * .5, SH * .3, "#DEB887"],
        [PAD * .5, SH * .55, "#DEB887"], [SW - PAD * .5, SH * .57, "#F4A460"],
        [PAD * .5, SH * .8, "#F4A460"], [SW - PAD * .5, SH * .82, "#DEB887"],
    ];
    shells.forEach(([sx, sy, sc]) => {
        ctx.save(); ctx.fillStyle = sc; ctx.globalAlpha = 0.85;
        star5(ctx, sx, sy, 8, 3.5, 5); ctx.restore();
    });
    // starfish
    [[SW * .5, SH - PAD * .5 + 4]].forEach(([sx, sy]) => {
        ctx.save(); ctx.fillStyle = "#FF7F50"; ctx.globalAlpha = 0.7;
        star5(ctx, sx, sy, 9, 4, 5); ctx.restore();
    });
    // wavy dividers
    for (let i = 0; i < 3; i++) {
        const divY = PAD + (FH + GAP) * (i + 1) - GAP / 2;
        wave(ctx, PAD, divY, FW, 2.5, 4, "#1E90FF", 0.5);
    }
    // border
    ctx.save(); ctx.strokeStyle = "#1E90FF"; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.6;
    ctx.strokeRect(4, 4, SW - 8, SH - 8);
    ctx.strokeStyle = "#FFD700"; ctx.lineWidth = 1; ctx.globalAlpha = 0.4;
    ctx.strokeRect(8, 8, SW - 16, SH - 16); ctx.restore();
    // label
    const ly = SH - 56;
    const llg = ctx.createLinearGradient(PAD, ly, PAD + FW, ly);
    llg.addColorStop(0, "rgba(30,80,180,0.35)"); llg.addColorStop(1, "rgba(30,144,255,0.25)");
    ctx.save(); ctx.fillStyle = llg; ctx.fillRect(PAD, ly, FW, 40); ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// PHOTO STRIP RENDERER
// ══════════════════════════════════════════════════════════════════════════════

function renderPhotoStrip(snapshots, filter) {
    const FW = 420, FH = 315;
    const PAD = 22, GAP = 10;
    const STRIP_W = FW + PAD * 2;
    const STRIP_H = PAD + (FH + GAP) * 4 + PAD + 64;

    const strip = document.createElement("canvas");
    strip.width = STRIP_W;
    strip.height = STRIP_H;
    const ctx = strip.getContext("2d");

    // Background
    ctx.fillStyle = filter.frame;
    ctx.fillRect(0, 0, STRIP_W, STRIP_H);

    // Outer border
    ctx.strokeStyle = filter.frameAccent;
    ctx.lineWidth = 2;
    ctx.strokeRect(5, 5, STRIP_W - 10, STRIP_H - 10);
    ctx.lineWidth = 0.5;
    ctx.strokeRect(9, 9, STRIP_W - 18, STRIP_H - 18);

    // Film sprocket holes (decorative)
    const holeColor = filter.frameAccent + "55";
    for (let i = 0; i < 4; i++) {
        const fy = PAD + i * (FH + GAP) + FH / 2 - 8;
        ctx.fillStyle = holeColor;
        [PAD - 14, PAD + FW + 5].forEach(hx => {
            ctx.beginPath(); ctx.roundRect(hx, fy, 8, 16, 2); ctx.fill();
        });
    }

    // Photos
    snapshots.forEach((snap, i) => {
        const fx = PAD, fy = PAD + i * (FH + GAP);
        ctx.drawImage(snap, fx, fy, FW, FH);
        // Thin border around each photo
        ctx.strokeStyle = filter.frameAccent + "60";
        ctx.lineWidth = 1;
        ctx.strokeRect(fx, fy, FW, FH);
    });

    // Bottom label
    const ly = STRIP_H - 56;
    ctx.fillStyle = filter.frameAccent + "25";
    ctx.fillRect(PAD, ly, FW, 40);

    ctx.fillStyle = filter.dateColor;
    ctx.font = `bold 11px 'Courier New', monospace`;
    ctx.textAlign = "left";
    ctx.fillText(filter.label.toUpperCase(), PAD + 10, ly + 15);
    ctx.font = `10px 'Courier New', monospace`;
    const now = new Date();
    ctx.fillText(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        PAD + 10, ly + 30
    );
    ctx.textAlign = "right";
    ctx.font = `bold 11px 'Courier New', monospace`;
    ctx.fillText("LIVEPHOTO ✦", PAD + FW - 10, ly + 15);
    ctx.font = `9px 'Courier New', monospace`;
    ctx.fillStyle = filter.dateColor + "99";
    ctx.fillText("ISO 400 · f/1.8", PAD + FW - 10, ly + 30);

    return strip;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

export default function RetroPhotobooth() {
    const videoRef = useRef(null);
    const liveCanvasRef = useRef(null);
    const poseRef = useRef(null);
    const cameraRef = useRef(null);
    const garmentInfoRef = useRef(null);   // { canvas, contentW, contentH, shoulderRow, shoulderWidthRatio }
    const latestLmRef = useRef(null);
    const fileInputRef = useRef(null);

    const [poseReady, setPoseReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [activeFilter, setActiveFilter] = useState(FILTERS[0]);
    const [garments, setGarments] = useState([]);
    const [activeGarment, setActiveGarment] = useState(null);
    const [processing, setProcessing] = useState(false); // bg removal in progress
    const [countdown, setCountdown] = useState(null);
    const [shutter, setShutter] = useState(false);
    const [snapshots, setSnapshots] = useState([]);
    const [stripCanvas, setStripCanvas] = useState(null);
    const [showStrip, setShowStrip] = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [activeFrame, setActiveFrame] = useState(FRAMES[0]);

    // ── Load MediaPipe ─────────────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        Promise.all(MP_SCRIPTS.map(loadScript))
            .then(() => waitForGlobal("Pose"))
            .then(() => { if (!cancelled) setPoseReady(true); })
            .catch(e => { if (!cancelled) setLoadError(e.message); });
        return () => { cancelled = true; };
    }, []);

    // ── Pose results ───────────────────────────────────────────────────────────
    const onPoseResults = useCallback((results) => {
        latestLmRef.current = results.poseLandmarks
            ? results.poseLandmarks.map(p => ({ ...p, x: 1 - p.x })) // mirror
            : null;
    }, []);

    // ── Init Pose ──────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!poseReady) return;
        const pose = new window.Pose({
            locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
        });
        pose.setOptions({
            modelComplexity: 1, smoothLandmarks: true,
            enableSegmentation: false, smoothSegmentation: false,
            minDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        pose.onResults(onPoseResults);
        poseRef.current = pose;
        return () => { pose.close(); poseRef.current = null; };
    }, [poseReady, onPoseResults]);

    // ── Camera + live render loop ──────────────────────────────────────────────
    useEffect(() => {
        if (!poseReady) return;
        const videoEl = videoRef.current;
        const canvas = liveCanvasRef.current;
        if (!videoEl || !canvas) return;

        let stopped = false;

        async function start() {
            try {
                canvas.width = 1280;
                canvas.height = 720;

                const cam = new window.Camera(videoEl, {
                    onFrame: async () => {
                        if (stopped || !poseRef.current) return;
                        // Sync canvas size
                        if (videoEl.videoWidth && canvas.width !== videoEl.videoWidth) {
                            canvas.width = videoEl.videoWidth;
                            canvas.height = videoEl.videoHeight;
                        }
                        await poseRef.current.send({ image: videoEl });

                        // Draw frame
                        const ctx = canvas.getContext("2d");
                        const W = canvas.width, H = canvas.height;
                        ctx.clearRect(0, 0, W, H);

                        // Mirrored video
                        ctx.save();
                        ctx.translate(W, 0); ctx.scale(-1, 1);
                        ctx.drawImage(videoEl, 0, 0, W, H);
                        ctx.restore();

                        // CSS filter effect
                        ctx.filter = activeFilter.css;
                        ctx.drawImage(canvas, 0, 0);
                        ctx.filter = "none";

                        // Garment overlay
                        if (garmentInfoRef.current && latestLmRef.current) {
                            drawGarmentOnCanvas(
                                ctx,
                                garmentInfoRef.current,
                                latestLmRef.current,
                                W, H
                            );
                        }

                        // Post-effects
                        applyVignette(ctx, W, H, activeFilter.vignette);
                        applyLightLeak(ctx, W, H, activeFilter.leak);
                    },
                    width: 1280, height: 720,
                });
                await cam.start();
                cameraRef.current = cam;
                if (!stopped) setIsLoading(false);
            } catch (e) {
                console.error(e);
                if (!stopped) setLoadError(e.message);
            }
        }

        start();
        return () => {
            stopped = true;
            if (cameraRef.current) { cameraRef.current.stop(); cameraRef.current = null; }
        };
    }, [poseReady, activeFilter]);

    // ── Upload + background removal ────────────────────────────────────────────
    async function handleFileUpload(e) {
        const files = Array.from(e.target.files);
        e.target.value = "";

        for (const file of files) {
            if (!file.type.startsWith("image/")) continue;

            setProcessing(true);

            const url = URL.createObjectURL(file);
            const img = await new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = url;
            });

            // Run background removal
            let processedCanvas;
            try {
                processedCanvas = await removeBackground(img);
            } catch (err) {
                console.error("BG removal failed:", err);
                // Fallback: use raw image on canvas
                processedCanvas = document.createElement("canvas");
                processedCanvas.width = img.naturalWidth;
                processedCanvas.height = img.naturalHeight;
                processedCanvas.getContext("2d").drawImage(img, 0, 0);
            }

            // Crop to tight content bounding box + detect shoulder line
            const garmentInfo = cropGarmentToContent(processedCanvas);
            if (!garmentInfo) { setProcessing(false); continue; }

            // Thumbnail from cropped canvas
            const thumbCanvas = document.createElement("canvas");
            thumbCanvas.width = 80;
            thumbCanvas.height = 80;
            thumbCanvas.getContext("2d").drawImage(garmentInfo.canvas, 0, 0, 80, 80);
            const thumbUrl = thumbCanvas.toDataURL();

            const entry = {
                id: Date.now() + Math.random(),
                name: file.name.replace(/\.[^.]+$/, ""),
                garmentInfo,
                thumbUrl,
                originalUrl: url,
            };

            setGarments(prev => [...prev, entry]);
            setActiveGarment(entry);
            garmentInfoRef.current = garmentInfo;
            // Reset EMA smoothing for new garment
            Object.assign(smooth, { x: undefined, y: undefined, w: undefined, h: undefined, a: undefined });

            setProcessing(false);
        }
    }

    function selectGarment(entry) {
        setActiveGarment(entry);
        garmentInfoRef.current = entry ? entry.garmentInfo : null;
        Object.assign(smooth, { x: undefined, y: undefined, w: undefined, h: undefined, a: undefined });
    }

    function removeGarmentEntry(id) {
        setGarments(prev => {
            const next = prev.filter(g => g.id !== id);
            if (activeGarment?.id === id) {
                const n = next[next.length - 1] || null;
                selectGarment(n);
            }
            return next;
        });
    }

    // ── Photo capture ──────────────────────────────────────────────────────────
    function captureFrame() {
        const src = liveCanvasRef.current;
        if (!src?.width) return null;
        const snap = document.createElement("canvas");
        snap.width = src.width;
        snap.height = src.height;
        const ctx = snap.getContext("2d");
        ctx.drawImage(src, 0, 0);
        applyGrain(ctx, snap.width, snap.height, activeFilter.grain);
        return snap;
    }

    async function startPhotobooth() {
        if (countdown !== null) return;
        setSnapshots([]); setShowStrip(false); setStripCanvas(null);
        const taken = [];

        for (let shot = 0; shot < 4; shot++) {
            for (let c = 3; c >= 1; c--) {
                setCountdown(c);
                await delay(850);
            }
            setCountdown(null);
            setShutter(true);
            await delay(130);
            setShutter(false);
            const f = captureFrame();
            if (f) { taken.push(f); setSnapshots([...taken]); }
            if (shot < 3) await delay(500);
        }

        if (taken.length > 0) {
            const strip = renderPhotoStrip(taken, activeFilter, activeFrame.id);
            setStripCanvas(strip);
            setShowStrip(true);
        }
    }

    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

    function downloadStrip() {
        if (!stripCanvas) return;
        const a = document.createElement("a");
        a.download = `livephoto_${activeFilter.id}_${activeFrame.id}_${Date.now()}.png`;
        a.href = stripCanvas.toDataURL("image/png");
        a.click();
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    return (
        <div style={C.page}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Special+Elite&family=DM+Mono:ital,wght@0,400;0,500;1,400&display=swap');
                @keyframes spin    { to { transform: rotate(360deg); } }
                @keyframes flash   { 0%{opacity:0} 15%{opacity:1} 100%{opacity:0} }
                @keyframes ticker  { 0%{opacity:1;transform:scale(1.05)} 100%{opacity:0;transform:scale(2.2)} }
                @keyframes slideUp { 0%{transform:translateY(24px);opacity:0} 100%{transform:translateY(0);opacity:1} }
                @keyframes pulse   { 0%,100%{opacity:0.5} 50%{opacity:1} }
                @keyframes bgpulse { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
            `}</style>

            {/* ── Grain texture overlay ─────────────────────────────────── */}
            <div style={C.grain} />

            {/* ── Header ───────────────────────────────────────────────── */}
            <header style={C.header}>
                <div style={C.brand}>
                    <span style={C.brandName}>LIVEPHOTO</span>
                    <span style={C.brandSub}>digital photobooth</span>
                </div>
                <div style={C.frameRow}>
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} style={{ ...C.frameThumb, ...(snapshots[i] ? C.frameThumbFilled : {}) }}>
                            {snapshots[i]
                                ? <img src={snapshots[i].toDataURL()} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 2 }} alt="" />
                                : <span style={C.frameThumbLabel}>{["I", "II", "III", "IV"][i]}</span>
                            }
                        </div>
                    ))}
                </div>
                <div style={C.headerRight}>
                    <div style={C.tabGroupLabel}>FILM</div>
                    <div style={C.filterTabs}>
                        {FILTERS.map(f => (
                            <button key={f.id} onClick={() => setActiveFilter(f)}
                                style={{ ...C.filterTab, ...(f.id === activeFilter.id ? C.filterTabActive : {}) }}>
                                {f.emoji} {f.label}
                            </button>
                        ))}
                    </div>
                    <div style={C.tabDivider} />
                    <div style={C.tabGroupLabel}>FRAME</div>
                    <div style={C.filterTabs}>
                        {FRAMES.map(fr => (
                            <button key={fr.id} onClick={() => setActiveFrame(fr)}
                                style={{ ...C.filterTab, ...(fr.id === activeFrame.id ? C.frameBtnActive : {}) }}>
                                {fr.emoji} {fr.label}
                            </button>
                        ))}
                    </div>
                </div>
            </header>

            {/* ── Body ─────────────────────────────────────────────────── */}
            <div style={C.body}>

                {/* LEFT: clothing panel */}
                <aside style={C.leftPanel}>
                    <div style={C.panelTitle}>CLOTHING</div>

                    <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileUpload} />

                    <button onClick={() => fileInputRef.current?.click()} style={C.uploadBtn} disabled={processing}>
                        {processing ? (
                            <>
                                <div style={C.miniSpinner} />
                                Removing BG…
                            </>
                        ) : (
                            <>
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                                Upload Clothing PNG
                            </>
                        )}
                    </button>

                    {processing && (
                        <div style={C.processingNote}>
                            Detecting &amp; removing background…
                        </div>
                    )}

                    {garments.length === 0 && !processing && (
                        <div style={C.emptyState}>
                            <div style={C.emptyIcon}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(232,223,200,0.25)" strokeWidth="1.5">
                                    <path d="M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.34 2.23l.58 3.57a1 1 0 00.99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 002-2V10h2.15a1 1 0 00.99-.84l.58-3.57a2 2 0 00-1.34-2.23z" />
                                </svg>
                            </div>
                            <span style={C.emptyText}>Upload any clothing PNG — background is removed automatically</span>
                        </div>
                    )}

                    <div style={C.garmentList}>
                        {garments.map(g => (
                            <div key={g.id}
                                onClick={() => selectGarment(g)}
                                style={{ ...C.garmentCard, ...(activeGarment?.id === g.id ? C.garmentCardActive : {}) }}>
                                {/* Processed thumbnail with checkered bg */}
                                <div style={C.thumbWrap}>
                                    <div style={C.thumbChecker} />
                                    <img src={g.thumbUrl} style={C.thumbImg} alt={g.name} />
                                </div>
                                <div style={C.garmentMeta}>
                                    <span style={C.garmentLabel}>{g.name}</span>
                                    {activeGarment?.id === g.id && (
                                        <span style={C.activePill}>ON</span>
                                    )}
                                </div>
                                <button onClick={e => { e.stopPropagation(); removeGarmentEntry(g.id); }} style={C.removeBtn}>×</button>
                            </div>
                        ))}
                    </div>

                    {activeGarment && (
                        <button onClick={() => selectGarment(null)} style={C.clearBtn}>
                            Remove overlay
                        </button>
                    )}
                </aside>

                {/* CENTRE: viewfinder */}
                <div style={C.viewfinder}>
                    {/* Flash */}
                    {shutter && <div style={C.flash} />}

                    {/* Countdown */}
                    {countdown !== null && (
                        <div style={C.countdownOverlay}>
                            <span style={C.countdownNum} key={countdown}>{countdown}</span>
                        </div>
                    )}

                    {/* Loading */}
                    {(isLoading || !poseReady) && !loadError && (
                        <div style={C.loaderBox}>
                            <div style={C.spinner} />
                            <span style={C.loaderText}>{!poseReady ? "Loading film…" : "Warming up…"}</span>
                        </div>
                    )}

                    {loadError && (
                        <div style={C.loaderBox}>
                            <span style={{ color: "#ff6b6b", fontSize: 11, fontFamily: "'DM Mono',monospace", textAlign: "center", padding: 16 }}>{loadError}</span>
                        </div>
                    )}

                    <video ref={videoRef} style={C.hiddenVideo} muted playsInline autoPlay />
                    <canvas ref={liveCanvasRef} style={{ ...C.liveCanvas, opacity: isLoading ? 0 : 1 }} />

                    {/* Corner marks */}
                    {["TL", "TR", "BL", "BR"].map(p => <div key={p} style={{ ...C.corner, ...C[`corner${p}`] }} />)}

                    {/* Film info bar */}
                    <div style={C.filmBar}>
                        <span>{activeFilter.label}</span>
                        <span style={C.filmDot} />
                        <span>ISO 400</span>
                        <span style={C.filmDot} />
                        <span>f/1.8</span>
                        {activeGarment && <><span style={C.filmDot} /><span style={{ color: "rgba(0,255,170,0.6)" }}>{activeGarment.name}</span></>}
                    </div>
                </div>

                {/* RIGHT: shoot + strip */}
                <aside style={C.rightPanel}>
                    {/* Shutter button */}
                    <button
                        onClick={startPhotobooth}
                        disabled={countdown !== null || isLoading}
                        style={{ ...C.shutterBtn, ...(countdown !== null || isLoading ? C.shutterDisabled : {}) }}
                        title="Take 4 photos"
                    >
                        <div style={C.shutterRing}>
                            <div style={C.shutterInner} />
                        </div>
                    </button>
                    <span style={C.shootLabel}>
                        {countdown !== null ? `Shooting ${[...snapshots].length + 1}/4…` : "Take Photos"}
                    </span>
                    <span style={C.shootSub}>4 shots · 3s each</span>

                    {/* Photo strip */}
                    {showStrip && stripCanvas && (
                        <div style={C.stripArea}>
                            <img src={stripCanvas.toDataURL()} style={C.stripImg} alt="photo strip" />
                            <button onClick={downloadStrip} style={C.downloadBtn}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
                                Save Strip
                            </button>
                            <button onClick={() => { setShowStrip(false); setSnapshots([]); setStripCanvas(null); }} style={C.retakeBtn}>
                                Retake
                            </button>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════════
const C = {
    page: {
        height: "100vh", overflow: "hidden",
        background: "#18150f",
        color: "#e8dfc8",
        fontFamily: "'Special Elite', serif",
        display: "flex", flexDirection: "column",
        position: "relative",
    },
    grain: {
        position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")`,
        backgroundSize: "150px 150px", opacity: 0.7, mixBlendMode: "overlay",
    },

    // Header
    header: {
        height: 52, display: "flex", alignItems: "center",
        padding: "0 16px", gap: 16, flexShrink: 0,
        borderBottom: "1px solid rgba(232,223,200,0.1)",
        background: "rgba(0,0,0,0.4)", position: "relative", zIndex: 10,
    },
    brand: { display: "flex", flexDirection: "column", gap: 1, flexShrink: 0 },
    brandName: { fontFamily: "'Special Elite',serif", fontSize: 18, letterSpacing: "0.12em", lineHeight: 1 },
    brandSub: { fontFamily: "'DM Mono',monospace", fontSize: 8, color: "rgba(232,223,200,0.3)", letterSpacing: "0.12em" },

    frameRow: { display: "flex", gap: 5, flexShrink: 0 },
    frameThumb: {
        width: 34, height: 26, borderRadius: 3, overflow: "hidden",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", justifyContent: "center",
    },
    frameThumbFilled: { border: "1px solid rgba(232,223,200,0.35)" },
    frameThumbLabel: { fontFamily: "'DM Mono',monospace", fontSize: 8, color: "rgba(232,223,200,0.2)" },

    filterTabs: { display: "flex", gap: 3, marginLeft: "auto" },
    filterTab: {
        fontFamily: "'DM Mono',monospace", fontSize: 10,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "rgba(232,223,200,0.4)",
        borderRadius: 5, padding: "4px 9px", cursor: "pointer",
        transition: "all 0.12s", letterSpacing: "0.02em",
    },
    filterTabActive: {
        background: "rgba(232,223,200,0.1)",
        borderColor: "rgba(232,223,200,0.3)",
        color: "#e8dfc8",
    },

    // Body layout
    body: {
        flex: 1, display: "grid",
        gridTemplateColumns: "200px 1fr 160px",
        minHeight: 0, position: "relative", zIndex: 1,
    },

    // Left panel
    leftPanel: {
        borderRight: "1px solid rgba(232,223,200,0.08)",
        background: "rgba(0,0,0,0.25)", padding: 14,
        display: "flex", flexDirection: "column", gap: 8,
        overflowY: "auto",
    },
    panelTitle: {
        fontFamily: "'DM Mono',monospace", fontSize: 9,
        letterSpacing: "0.2em", color: "rgba(232,223,200,0.3)",
        marginBottom: 2,
    },
    uploadBtn: {
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        background: "rgba(232,223,200,0.06)",
        border: "1.5px dashed rgba(232,223,200,0.25)",
        borderRadius: 8, padding: "9px 0",
        color: "#e8dfc8", cursor: "pointer",
        fontFamily: "'DM Mono',monospace", fontSize: 11,
        transition: "all 0.15s", width: "100%",
    },
    miniSpinner: {
        width: 12, height: 12,
        border: "1.5px solid rgba(232,223,200,0.2)",
        borderTop: "1.5px solid #e8dfc8",
        borderRadius: "50%", animation: "spin 0.7s linear infinite",
    },
    processingNote: {
        fontFamily: "'DM Mono',monospace", fontSize: 9,
        color: "rgba(232,223,200,0.4)", textAlign: "center",
        animation: "pulse 1.2s ease-in-out infinite",
    },
    emptyState: {
        display: "flex", flexDirection: "column",
        alignItems: "center", gap: 8, padding: "16px 4px",
    },
    emptyIcon: {
        width: 48, height: 48, borderRadius: "50%",
        background: "rgba(255,255,255,0.03)",
        display: "flex", alignItems: "center", justifyContent: "center",
    },
    emptyText: {
        fontFamily: "'DM Mono',monospace", fontSize: 9,
        color: "rgba(232,223,200,0.25)", textAlign: "center", lineHeight: 1.6,
    },
    garmentList: { display: "flex", flexDirection: "column", gap: 6 },
    garmentCard: {
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 8px", borderRadius: 8, cursor: "pointer",
        border: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(255,255,255,0.02)",
        transition: "all 0.12s",
    },
    garmentCardActive: {
        border: "1px solid rgba(232,223,200,0.25)",
        background: "rgba(232,223,200,0.06)",
    },

    // Checkered bg for transparent preview
    thumbWrap: { position: "relative", width: 36, height: 36, flexShrink: 0 },
    thumbChecker: {
        position: "absolute", inset: 0, borderRadius: 4,
        backgroundImage: "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)",
        backgroundSize: "6px 6px",
        backgroundPosition: "0 0,0 3px,3px -3px,-3px 0",
        opacity: 0.15,
    },
    thumbImg: {
        position: "absolute", inset: 0, width: "100%", height: "100%",
        objectFit: "contain", borderRadius: 4,
    },
    garmentMeta: { flex: 1, display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" },
    garmentLabel: {
        fontFamily: "'DM Mono',monospace", fontSize: 10,
        color: "rgba(232,223,200,0.65)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    },
    activePill: {
        alignSelf: "flex-start",
        background: "rgba(0,255,170,0.15)",
        border: "1px solid rgba(0,255,170,0.3)",
        color: "#00ffaa", borderRadius: 3,
        fontFamily: "'DM Mono',monospace", fontSize: 8, padding: "1px 5px",
    },
    removeBtn: {
        background: "none", border: "none", color: "rgba(255,100,100,0.4)",
        cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 2px", flexShrink: 0,
    },
    clearBtn: {
        background: "transparent",
        border: "1px solid rgba(255,100,100,0.2)",
        borderRadius: 6, color: "rgba(255,100,100,0.5)",
        padding: "6px", fontSize: 10, cursor: "pointer",
        fontFamily: "'DM Mono',monospace",
    },

    // Viewfinder
    viewfinder: {
        position: "relative", background: "#0a0805",
        overflow: "hidden", display: "flex",
        alignItems: "center", justifyContent: "center",
    },
    hiddenVideo: {
        position: "absolute", left: "-9999px", top: 0,
        width: "1280px", height: "720px", visibility: "hidden",
    },
    liveCanvas: {
        width: "100%", height: "100%", objectFit: "cover",
        display: "block", transition: "opacity 0.5s ease",
    },
    flash: {
        position: "absolute", inset: 0, background: "#fff",
        zIndex: 60, animation: "flash 0.2s ease-out forwards",
        pointerEvents: "none",
    },
    countdownOverlay: {
        position: "absolute", inset: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)", pointerEvents: "none",
    },
    countdownNum: {
        fontFamily: "'Special Elite',serif",
        fontSize: 130, color: "#e8dfc8",
        textShadow: "0 0 60px rgba(232,223,200,0.3)",
        animation: "ticker 0.85s ease-out forwards",
    },
    loaderBox: {
        position: "absolute", inset: 0, zIndex: 40,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: "rgba(10,8,5,0.9)", gap: 14,
    },
    spinner: {
        width: 38, height: 38,
        border: "2px solid rgba(232,223,200,0.1)",
        borderTop: "2px solid rgba(232,223,200,0.7)",
        borderRadius: "50%", animation: "spin 0.8s linear infinite",
    },
    loaderText: {
        fontFamily: "'DM Mono',monospace", fontSize: 11,
        color: "rgba(232,223,200,0.35)", letterSpacing: "0.1em",
    },
    corner: { position: "absolute", width: 18, height: 18, pointerEvents: "none" },
    cornerTL: { top: 14, left: 14, borderTop: "1.5px solid rgba(232,223,200,0.3)", borderLeft: "1.5px solid rgba(232,223,200,0.3)" },
    cornerTR: { top: 14, right: 14, borderTop: "1.5px solid rgba(232,223,200,0.3)", borderRight: "1.5px solid rgba(232,223,200,0.3)" },
    cornerBL: { bottom: 14, left: 14, borderBottom: "1.5px solid rgba(232,223,200,0.3)", borderLeft: "1.5px solid rgba(232,223,200,0.3)" },
    cornerBR: { bottom: 14, right: 14, borderBottom: "1.5px solid rgba(232,223,200,0.3)", borderRight: "1.5px solid rgba(232,223,200,0.3)" },
    filmBar: {
        position: "absolute", bottom: 10, left: 16,
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "'DM Mono',monospace", fontSize: 9,
        color: "rgba(232,223,200,0.3)", letterSpacing: "0.06em",
        pointerEvents: "none",
    },
    filmDot: {
        display: "inline-block", width: 3, height: 3,
        borderRadius: "50%", background: "rgba(232,223,200,0.2)",
    },

    // Right panel
    rightPanel: {
        borderLeft: "1px solid rgba(232,223,200,0.08)",
        background: "rgba(0,0,0,0.25)", padding: 14,
        display: "flex", flexDirection: "column",
        alignItems: "center", gap: 8, overflowY: "auto",
    },
    shutterBtn: {
        cursor: "pointer", background: "none", border: "none",
        padding: 0, transition: "transform 0.1s",
        marginTop: 8,
    },
    shutterDisabled: { opacity: 0.35, cursor: "not-allowed" },
    shutterRing: {
        width: 64, height: 64, borderRadius: "50%",
        border: "2.5px solid rgba(232,223,200,0.35)",
        background: "rgba(232,223,200,0.05)",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.15s",
    },
    shutterInner: {
        width: 42, height: 42, borderRadius: "50%",
        background: "#e8dfc8",
    },
    shootLabel: {
        fontFamily: "'DM Mono',monospace", fontSize: 10,
        color: "rgba(232,223,200,0.5)", textAlign: "center",
    },
    shootSub: {
        fontFamily: "'DM Mono',monospace", fontSize: 8,
        color: "rgba(232,223,200,0.2)",
    },
    stripArea: {
        display: "flex", flexDirection: "column",
        alignItems: "center", gap: 7, width: "100%",
        animation: "slideUp 0.4s ease",
    },
    stripImg: {
        width: "100%", borderRadius: 3,
        border: "1px solid rgba(232,223,200,0.15)",
        boxShadow: "0 6px 24px rgba(0,0,0,0.7)",
    },
    downloadBtn: {
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        background: "#e8dfc8", color: "#18150f",
        border: "none", borderRadius: 8, padding: "8px 0",
        fontFamily: "'DM Mono',monospace", fontSize: 11, fontWeight: 600,
        cursor: "pointer", width: "100%",
    },
    retakeBtn: {
        background: "transparent",
        border: "1px solid rgba(232,223,200,0.12)",
        borderRadius: 6, color: "rgba(232,223,200,0.35)",
        padding: "5px 0", fontSize: 10, cursor: "pointer",
        fontFamily: "'DM Mono',monospace", width: "100%",
    },

    // Header right group
    headerRight: {
        display: "flex", alignItems: "center", gap: 6,
        marginLeft: "auto", flexWrap: "wrap",
    },
    tabGroupLabel: {
        fontFamily: "'DM Mono',monospace", fontSize: 8,
        letterSpacing: "0.18em", color: "rgba(232,223,200,0.28)",
    },
    tabDivider: {
        width: 1, height: 18,
        background: "rgba(232,223,200,0.12)",
        margin: "0 4px",
    },
    frameBtnActive: {
        background: "rgba(255,220,100,0.14)",
        borderColor: "rgba(255,220,100,0.45)",
        color: "#FFE080",
    },
};

