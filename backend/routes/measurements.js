// routes/measurements.js
// Saves buyer body measurements and retrieves them per session.

import { Router } from "express";
import { pool } from "../db/index.js";

const router = Router();

/**
 * POST /api/measurements
 * Body: { sessionId, shoulderWidthCm, torsoHeightCm, hipWidthCm, estimatedHeightCm }
 */
router.post("/", async (req, res) => {
    try {
        const {
            sessionId,
            shoulderWidthCm,
            torsoHeightCm,
            hipWidthCm,
            estimatedHeightCm,
        } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required" });
        }

        const [result] = await pool.execute(
            `INSERT INTO measurements
         (session_id, shoulder_width_cm, torso_height_cm, hip_width_cm, estimated_height_cm)
       VALUES (?, ?, ?, ?, ?)`,
            [sessionId, shoulderWidthCm, torsoHeightCm, hipWidthCm, estimatedHeightCm]
        );

        res.status(201).json({ id: result.insertId, sessionId });
    } catch (err) {
        console.error("[measurements] save error:", err);
        res.status(500).json({ error: "Failed to save measurements" });
    }
});

// GET /api/measurements/:sessionId — latest measurement for a session
router.get("/:sessionId", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM measurements
        WHERE session_id = ?
        ORDER BY recorded_at DESC
        LIMIT 1`,
            [req.params.sessionId]
        );

        if (!rows.length) return res.status(404).json({ error: "No measurements found" });
        res.json(rows[0]);
    } catch (err) {
        console.error("[measurements] fetch error:", err);
        res.status(500).json({ error: "Failed to fetch measurements" });
    }
});

export default router;