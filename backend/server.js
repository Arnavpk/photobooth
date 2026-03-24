// server.js — entry point
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import { initDB } from "./db/index.js";
import agoraRoutes from "./routes/agora.js";
import sessionRoutes from "./routes/sessions.js";
import garmentRoutes from "./routes/garments.js";
import measureRoutes from "./routes/measurements.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
const PORT = process.env.PORT || 8000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/agora", agoraRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/garments", garmentRoutes);
app.use("/api/measurements", measureRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
    try {
        await initDB();           // connect to MySQL + create tables
        app.listen(PORT, () => {
            console.log(`🚀 Backend running at http://localhost:${PORT}`);
            console.log(`   Health: http://localhost:${PORT}/health`);
        });
    } catch (err) {
        console.error("❌ Startup failed:", err.message);
        console.error("   → Is MySQL running? Check DB_HOST / DB_PORT in .env");
        process.exit(1);
    }
}

start();