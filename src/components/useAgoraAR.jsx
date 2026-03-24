/**
 * useAgoraAR.js  (fixed v2)
 *
 * Fix: "OPERATION_ABORTED: cancel token canceled"
 *   Root cause: React StrictMode double-invokes useEffect in development.
 *   The cleanup (client.leave) ran while join() was still awaiting, which
 *   caused Agora to cancel its own in-flight token.
 *
 *   Solution:
 *     1. Use an `aborted` flag — if cleanup fires before join completes,
 *        we skip publish/setState and leave silently.
 *     2. Keep the Agora client in a module-level ref so it is only created
 *        ONCE even if the effect runs twice (StrictMode).
 *     3. Guard client.leave() so it only runs if the client actually joined.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import AgoraRTC from "agora-rtc-sdk-ng";
import React from "react";

// ── Suppress Agora's noisy dev-mode console warnings ─────────────────────────
AgoraRTC.setLogLevel(4); // 4 = ERROR only (0=DEBUG, 1=INFO, 2=WARN, 3=ERROR, 4=NONE)

export function useAgoraAR({
    appId,
    channel,
    token,
    uid,
    onRemoteUserJoined = () => { },
}) {
    // Use refs to avoid duplicate join attempts in StrictMode or repeated rerenders
    const clientRef = useRef(null);
    const hasJoinedRef = useRef(false); // track whether client.join succeeded
    const isJoiningRef = useRef(false); // guard against concurrent join()

    const [localTrack, setLocalTrack] = useState(null);
    const [remoteUsers, setRemoteUsers] = useState([]);
    const [joined, setJoined] = useState(false);
    const [error, setError] = useState(null);

    // ── Calibration state ─────────────────────────────────────────────────────
    const [referencePixelWidth, setReferencePixelWidth] = useState(0);
    const [ppcm, setPpcm] = useState(0);
    const [isCalibrated, setIsCalibrated] = useState(false);

    // ── Agora setup ───────────────────────────────────────────────────────────
    useEffect(() => {
        let aborted = false;   // set true by cleanup — stops in-flight join
        let trackRef = null;    // local camera track, so cleanup can close it

        // Reuse existing client if StrictMode re-runs this effect
        if (!clientRef.current) {
            clientRef.current = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        }
        const client = clientRef.current;

        // Only bind listeners once.
        if (!client.listenerSetup) {
            client.on("user-published", async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                if (mediaType === "video") {
                    setRemoteUsers((prev) => [...prev.filter((u) => u.uid !== user.uid), user]);
                    onRemoteUserJoined(user);
                }
            });

            client.on("user-unpublished", (user) => {
                setRemoteUsers((prev) => prev.filter((u) => u.uid !== user.uid));
            });

            client.listenerSetup = true;
        }

        async function join() {
            if (hasJoinedRef.current || isJoiningRef.current) {
                console.warn("[Agora] join() skipped: already joining/connected");
                return;
            }
            isJoiningRef.current = true;
            try {
                // Agora requires exactly null (not "" or undefined) when not using a token
                const safeToken = token || null;

                await client.join(appId, channel, safeToken, uid);
                hasJoinedRef.current = true;

                // If cleanup already ran (StrictMode), bail out cleanly
                if (aborted) {
                    await client.leave();
                    hasJoinedRef.current = false;
                    return;
                }

                const track = await AgoraRTC.createCameraVideoTrack({
                    encoderConfig: { width: 1280, height: 720, frameRate: 30, bitrateMax: 2500 },
                });
                trackRef = track;

                if (aborted) {
                    track.close();
                    await client.leave();
                    hasJoinedRef.current = false;
                    return;
                }

                await client.publish([track]);
                setLocalTrack(track);
                setJoined(true);
            } catch (err) {
                // OPERATION_ABORTED is expected during StrictMode cleanup — suppress it
                if (err?.code === "OPERATION_ABORTED" || aborted) return;
                console.error("[Agora] join error:", err);
                setError(err);
            } finally {
                isJoiningRef.current = false;
            }
        }

        join();

        // ── Cleanup ──────────────────────────────────────────────────────────────
        return () => {
            aborted = true;
            // Close camera track if it was created
            if (trackRef) { trackRef.close(); trackRef = null; }
            setLocalTrack(null);
            setJoined(false);
            // Only leave if we actually joined (avoids spurious leave errors)
            if (hasJoinedRef.current) {
                client.leave().catch(() => { });
                hasJoinedRef.current = false;
            }
        };
    }, [appId, channel, token, uid]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Calibration ───────────────────────────────────────────────────────────
    const handleCalibrated = useCallback((newPpcm) => {
        setPpcm(newPpcm);
        setIsCalibrated(true);
    }, []);

    return {
        client: clientRef.current,
        localTrack,
        remoteUsers,
        joined,
        error,
        referencePixelWidth,
        setReferencePixelWidth,
        ppcm,
        isCalibrated,
        handleCalibrated,
    };
}

// ─── CalibrationOverlay ───────────────────────────────────────────────────────
// Lets the buyer draw a box around a reference object to calibrate size.

export function CalibrationOverlay({ onMeasured, active = false }) {
    const overlayRef = useRef(null);
    const [drawing, setDrawing] = useState(false);
    const [startPt, setStartPt] = useState(null);
    const [rect, setRect] = useState(null);
    const [confirmed, setConfirmed] = useState(false);

    function getPos(e, el) {
        const b = el.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - b.left, y: clientY - b.top };
    }

    function onPointerDown(e) {
        if (!active) return;
        const pos = getPos(e, overlayRef.current);
        setDrawing(true); setStartPt(pos); setRect(null); setConfirmed(false);
    }
    function onPointerMove(e) {
        if (!drawing || !startPt) return;
        const pos = getPos(e, overlayRef.current);
        setRect({
            x: Math.min(startPt.x, pos.x), y: Math.min(startPt.y, pos.y),
            w: Math.abs(pos.x - startPt.x), h: Math.abs(pos.y - startPt.y),
        });
    }
    function onPointerUp() {
        if (!drawing) return;
        setDrawing(false);
        if (rect && rect.w > 10) setConfirmed(true);
    }
    function confirm() {
        if (rect) { onMeasured(rect.w); setConfirmed(false); setRect(null); }
    }

    if (!active) return null;

    return (
        <div
            ref={overlayRef}
            onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp}
            onTouchStart={onPointerDown} onTouchMove={onPointerMove} onTouchEnd={onPointerUp}
            style={{ position: "absolute", inset: 0, zIndex: 50, cursor: "crosshair", userSelect: "none" }}
        >
            {rect && (
                <div style={{
                    position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h,
                    border: "2px dashed #ffdd00",
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)", pointerEvents: "none",
                }} />
            )}
            {confirmed && (
                <button onClick={confirm} style={{
                    position: "absolute", left: rect.x + rect.w / 2, top: rect.y + rect.h + 12,
                    transform: "translateX(-50%)", background: "#ffdd00", color: "#000",
                    fontWeight: "bold", border: "none", borderRadius: "6px",
                    padding: "8px 20px", cursor: "pointer", fontSize: "14px", zIndex: 60,
                }}>
                    Confirm Reference
                </button>
            )}
            <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%,-50%)",
                color: "#fff", fontFamily: "sans-serif", fontSize: "15px", textAlign: "center",
                pointerEvents: "none", textShadow: "0 1px 4px rgba(0,0,0,0.8)",
            }}>
                Draw a box around your credit card / reference object
            </div>
        </div>
    );
}