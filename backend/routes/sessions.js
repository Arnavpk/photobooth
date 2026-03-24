// routes/sessions.js
// CRUD for live shopping sessions (channel management).

import { Router } from "express";
import { pool } from "../db/index.js";
import { randomUUID } from "crypto";

const router = Router();

// POST /api/sessions — create a new session
router.post("/", async (req, res) => {
    try {
        const id = randomUUID();
        const channel = `room-${id.slice(0, 8)}`;

        await pool.execute(
            "INSERT INTO sessions (id, channel_name) VALUES (?, ?)",
            [id, channel]
        );

        res.status(201).json({ id, channel_name: channel, status: "waiting" });
    } catch (err) {
        console.error("[sessions] create error:", err);
        res.status(500).json({ error: "Failed to create session" });
    }
});

// GET /api/sessions/:id — fetch a session by ID
router.get("/:id", async (req, res) => {
    try {
        const [rows] = await pool.execute(
            "SELECT * FROM sessions WHERE id = ?",
            [req.params.id]
        );
        if (!rows.length) return res.status(404).json({ error: "Session not found" });
        res.json(rows[0]);
    } catch (err) {
        console.error("[sessions] fetch error:", err);
        res.status(500).json({ error: "Failed to fetch session" });
    }
});

// PATCH /api/sessions/:id — update status or UIDs
router.patch("/:id", async (req, res) => {
    try {
        const { status, salesperson_uid, buyer_uid } = req.body;
        const allowed = ["waiting", "active", "ended"];

        if (status && !allowed.includes(status)) {
            return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
        }

        await pool.execute(
            `UPDATE sessions
          SET status           = COALESCE(?, status),
              salesperson_uid  = COALESCE(?, salesperson_uid),
              buyer_uid        = COALESCE(?, buyer_uid)
        WHERE id = ?`,
            [status || null, salesperson_uid || null, buyer_uid || null, req.params.id]
        );

        const [rows] = await pool.execute("SELECT * FROM sessions WHERE id = ?", [req.params.id]);
        res.json(rows[0]);
    } catch (err) {
        console.error("[sessions] update error:", err);
        res.status(500).json({ error: "Failed to update session" });
    }
});

export default router;