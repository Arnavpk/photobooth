/**
 * LiveShoppingRoom.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Top-level page that wires Agora + AR Try-On + Calibration together.
 *
 * Layout:
 *   ┌────────────────┬──────────────────┐
 *   │  Salesperson   │   Buyer (AR)     │
 *   │  Agora stream  │   Canvas overlay │
 *   └────────────────┴──────────────────┘
 *   └────── Measurement sidebar ─────────┘
 */

import React, { useState, useRef, useEffect } from "react";
import ARTryOnOverlay from "./Artryonoverlay";
import { useAgoraAR, CalibrationOverlay } from "./useAgoraAR";

// ─── Salesperson remote video player ─────────────────────────────────────────

function RemoteVideo({ user }) {
    const ref = useRef(null);
    useEffect(() => {
        if (user?.videoTrack && ref.current) {
            user.videoTrack.play(ref.current);
        }
        return () => user?.videoTrack?.stop();
    }, [user]);
    return (
        <div style={styles.videoPane}>
            <div ref={ref} style={{ width: "100%", height: "100%" }} />
            <div style={styles.videoLabel}>🛍 Salesperson</div>
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LiveShoppingRoom() {
    // In production, pull these from your backend / env
    const AGORA_CONFIG = {
        appId: import.meta.env.VITE_AGORA_APP_ID ?? "YOUR_APP_ID",
        channel: import.meta.env.VITE_AGORA_CHANNEL ?? "shopping-room-1",
        token: import.meta.env.VITE_AGORA_TOKEN || null,  // empty string → null
        uid: null, // let Agora auto-assign
    };

    const {
        localTrack,
        remoteUsers,
        joined,
        error,
        referencePixelWidth,
        setReferencePixelWidth,
        isCalibrated,
        handleCalibrated,
    } = useAgoraAR(AGORA_CONFIG);

    // Garment selection state
    const [selectedGarment, setSelectedGarment] = useState("/garments/shirt_front.svg");
    const [showCalibration, setShowCalibration] = useState(false);
    const [measurements, setMeasurements] = useState(null);
    const [showSkeleton, setShowSkeleton] = useState(false);

    const GARMENTS = [
        { label: "Casual Shirt", src: "/garments/shirt_front.svg" },
        { label: "Formal Blazer", src: "/garments/blazer_front.svg" },
        { label: "Summer Dress", src: "/garments/dress_front.svg" },
        { label: "Hoodie", src: "/garments/hoodie_front.svg" },
    ];

    if (error) {
        return <div style={styles.error}>❌ Agora error: {error.message}</div>;
    }

    return (
        <div style={styles.page}>
            {/* ── Header ──────────────────────────────────────────────────────────── */}
            <header style={styles.header}>
                <span style={styles.logo}>✨ LiveFit AR</span>
                <div style={styles.status}>
                    <span style={{ ...styles.dot, background: joined ? "#00ff88" : "#ff4444" }} />
                    {joined ? "Live" : "Connecting…"}
                </div>
            </header>

            {/* ── Video area ──────────────────────────────────────────────────────── */}
            <div style={styles.videoRow}>
                {/* Salesperson stream */}
                {remoteUsers.length > 0 ? (
                    <RemoteVideo user={remoteUsers[0]} />
                ) : (
                    <div style={{ ...styles.videoPane, ...styles.waitingPane }}>
                        <span>Waiting for salesperson…</span>
                    </div>
                )}

                {/* Buyer AR view */}
                <div style={{ ...styles.videoPane, position: "relative" }}>
                    <ARTryOnOverlay
                        agoraLocalTrack={localTrack}
                        garmentSrc={selectedGarment}
                        garmentType="2d"
                        referencePixelWidth={referencePixelWidth}
                        onMeasurement={setMeasurements}
                        onCalibrated={handleCalibrated}
                        showSkeleton={showSkeleton}
                        showMeasurements={true}
                    />
                    <CalibrationOverlay
                        active={showCalibration}
                        onMeasured={(px) => {
                            setReferencePixelWidth(px);
                            setShowCalibration(false);
                        }}
                    />
                    <div style={styles.videoLabel}>🪞 You (AR Mirror)</div>
                </div>
            </div>

            {/* ── Controls row ────────────────────────────────────────────────────── */}
            <div style={styles.controls}>
                {/* Garment picker */}
                <div style={styles.controlGroup}>
                    <label style={styles.controlLabel}>Try On:</label>
                    <div style={styles.garmentRow}>
                        {GARMENTS.map((g) => (
                            <button
                                key={g.src}
                                onClick={() => setSelectedGarment(g.src)}
                                style={{
                                    ...styles.garmentBtn,
                                    ...(selectedGarment === g.src ? styles.garmentBtnActive : {}),
                                }}
                            >
                                {g.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Calibration */}
                <div style={styles.controlGroup}>
                    <button
                        onClick={() => setShowCalibration((v) => !v)}
                        style={styles.calibrateBtn}
                    >
                        {isCalibrated ? "✅ Recalibrate" : "🪪 Calibrate Size"}
                    </button>
                    <label style={styles.toggleLabel}>
                        <input
                            type="checkbox"
                            checked={showSkeleton}
                            onChange={(e) => setShowSkeleton(e.target.checked)}
                        />
                        &nbsp;Debug skeleton
                    </label>
                </div>
            </div>

            {/* ── Measurements panel ──────────────────────────────────────────────── */}
            {measurements && isCalibrated && (
                <div style={styles.measurePanel}>
                    <h3 style={styles.measureTitle}>📏 Your Measurements</h3>
                    <div style={styles.measureGrid}>
                        {[
                            ["Shoulders", measurements.shoulderWidthCm, "cm"],
                            ["Torso Height", measurements.torsoHeightCm, "cm"],
                            ["Hip Width", measurements.hipWidthCm, "cm"],
                            ["Est. Height", measurements.estimatedHeightCm, "cm"],
                        ].map(([label, val, unit]) => (
                            <div key={label} style={styles.measureCard}>
                                <span style={styles.measureVal}>{val}<sub>{unit}</sub></span>
                                <span style={styles.measureLbl}>{label}</span>
                            </div>
                        ))}
                    </div>
                    <p style={styles.measureNote}>
                        * Measurements are estimates. ±5% accuracy with credit-card calibration.
                    </p>
                </div>
            )}
        </div>
    );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = {
    page: {
        minHeight: "100vh",
        background: "#0a0a0f",
        color: "#fff",
        fontFamily: "'Inter', sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: "0",
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.03)",
    },
    logo: {
        fontSize: "20px",
        fontWeight: "700",
        letterSpacing: "-0.5px",
    },
    status: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "13px",
        color: "rgba(255,255,255,0.7)",
    },
    dot: {
        width: "8px",
        height: "8px",
        borderRadius: "50%",
    },
    videoRow: {
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "2px",
        height: "calc(100vh - 200px)",
        minHeight: "400px",
    },
    videoPane: {
        position: "relative",
        background: "#111",
        overflow: "hidden",
    },
    waitingPane: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.3)",
        fontSize: "15px",
    },
    videoLabel: {
        position: "absolute",
        top: "12px",
        left: "12px",
        background: "rgba(0,0,0,0.6)",
        color: "#fff",
        fontSize: "12px",
        fontWeight: "600",
        padding: "4px 10px",
        borderRadius: "20px",
        zIndex: 40,
    },
    controls: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "24px",
        padding: "14px 24px",
        background: "rgba(255,255,255,0.03)",
        borderTop: "1px solid rgba(255,255,255,0.08)",
    },
    controlGroup: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
    },
    controlLabel: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.5)",
        marginRight: "4px",
    },
    garmentRow: {
        display: "flex",
        gap: "8px",
    },
    garmentBtn: {
        background: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "#fff",
        padding: "6px 14px",
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "13px",
        transition: "all 0.15s",
    },
    garmentBtnActive: {
        background: "rgba(0,255,170,0.15)",
        borderColor: "#00ffaa",
        color: "#00ffaa",
    },
    calibrateBtn: {
        background: "rgba(255,210,0,0.15)",
        border: "1px solid rgba(255,210,0,0.4)",
        color: "#ffd200",
        padding: "7px 16px",
        borderRadius: "6px",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: "600",
    },
    toggleLabel: {
        fontSize: "13px",
        color: "rgba(255,255,255,0.5)",
        cursor: "pointer",
    },
    measurePanel: {
        padding: "20px 24px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
    },
    measureTitle: {
        fontSize: "15px",
        fontWeight: "600",
        marginBottom: "14px",
        color: "rgba(255,255,255,0.8)",
    },
    measureGrid: {
        display: "flex",
        gap: "16px",
        flexWrap: "wrap",
    },
    measureCard: {
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "10px",
        padding: "12px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "4px",
        minWidth: "110px",
    },
    measureVal: {
        fontSize: "24px",
        fontWeight: "700",
        color: "#00ffaa",
    },
    measureLbl: {
        fontSize: "11px",
        color: "rgba(255,255,255,0.45)",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
    },
    measureNote: {
        marginTop: "10px",
        fontSize: "11px",
        color: "rgba(255,255,255,0.3)",
    },
    error: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        color: "#ff6b6b",
        fontFamily: "monospace",
    },
};