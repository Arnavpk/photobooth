// routes/garments.js
// Returns garment catalogue and size comparison logic.

import { Router } from "express";
import { pool } from "../db/index.js";

const router = Router();

// GET /api/garments — full catalogue
router.get("/", async (_req, res) => {
    try {
        const [rows] = await pool.execute("SELECT * FROM garments ORDER BY id");
        res.json(rows);
    } catch (err) {
        console.error("[garments] list error:", err);
        res.status(500).json({ error: "Failed to fetch garments" });
    }
});

// GET /api/garments/:id — single garment
router.get("/:id", async (req, res) => {
    try {
        const [rows] = await pool.execute("SELECT * FROM garments WHERE id = ?", [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: "Garment not found" });
        res.json(rows[0]);
    } catch (err) {
        console.error("[garments] fetch error:", err);
        res.status(500).json({ error: "Failed to fetch garment" });
    }
});

/**
 * POST /api/garments/recommend
 * Body: { shoulderWidthCm, hipWidthCm, garmentId }
 * Returns the best-fit size label based on buyer measurements.
 *
 * Size chart (cm) — industry standard approximations
 */
const SIZE_CHART = {
    shoulder: { XS: 36, S: 38, M: 40, L: 43, XL: 46, XXL: 50 },
    hip: { XS: 84, S: 88, M: 92, L: 97, XL: 103, XXL: 110 },
};

router.post("/recommend", async (req, res) => {
    try {
        const { shoulderWidthCm, hipWidthCm } = req.body;

        if (!shoulderWidthCm || !hipWidthCm) {
            return res.status(400).json({ error: "shoulderWidthCm and hipWidthCm are required" });
        }

        const shoulder = parseFloat(shoulderWidthCm);
        const hip = parseFloat(hipWidthCm);

        // Find closest size by shoulder measurement
        let bestSize = "M";
        let bestDelta = Infinity;

        for (const [size, value] of Object.entries(SIZE_CHART.shoulder)) {
            const delta = Math.abs(shoulder - value);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestSize = size;
            }
        }

        // Verify hip measurement agrees — if not, recommend going up one size
        const hipForSize = SIZE_CHART.hip[bestSize];
        const sizeKeys = Object.keys(SIZE_CHART.hip);
        const sizeIndex = sizeKeys.indexOf(bestSize);
        const recommendUp = hip > hipForSize && sizeIndex < sizeKeys.length - 1;
        const finalSize = recommendUp ? sizeKeys[sizeIndex + 1] : bestSize;

        res.json({
            recommendedSize: finalSize,
            basedOn: { shoulder, hip },
            note: recommendUp
                ? `Hip measurement (${hip}cm) suggests sizing up from ${bestSize} to ${finalSize}`
                : `Best match for shoulder ${shoulder}cm`,
        });
    } catch (err) {
        console.error("[garments] recommend error:", err);
        res.status(500).json({ error: "Recommendation failed" });
    }
});

export default router;