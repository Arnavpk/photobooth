

import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// ── Connection pool ───────────────────────────────────────────────────────────
export const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "live_shopping",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// ── Schema ────────────────────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id           VARCHAR(36)  PRIMARY KEY,
    channel_name VARCHAR(100) NOT NULL UNIQUE,
    salesperson_uid INT,
    buyer_uid       INT,
    status       ENUM('waiting','active','ended') DEFAULT 'waiting',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS garments (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    image_url   VARCHAR(500) NOT NULL,
    sizes       JSON,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS measurements (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    session_id          VARCHAR(36) NOT NULL,
    shoulder_width_cm   DECIMAL(5,1),
    torso_height_cm     DECIMAL(5,1),
    hip_width_cm        DECIMAL(5,1),
    estimated_height_cm DECIMAL(5,1),
    recorded_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

// ── Seed data ─────────────────────────────────────────────────────────────────
const SEED_GARMENTS = `
  INSERT IGNORE INTO garments (id, name, image_url, sizes) VALUES
  (1, 'Casual Shirt',  '/garments/shirt_front.png',  '["XS","S","M","L","XL"]'),
  (2, 'Formal Blazer', '/garments/blazer_front.png', '["S","M","L","XL"]'),
  (3, 'Summer Dress',  '/garments/dress_front.png',  '["XS","S","M","L"]'),
  (4, 'Hoodie',        '/garments/hoodie_front.png', '["S","M","L","XL","XXL"]');
`;

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initDB() {
    const conn = await pool.getConnection();
    try {
        // Run each statement individually (mysql2 doesn't support multi-statement by default)
        const statements = SCHEMA.split(";").map(s => s.trim()).filter(Boolean);
        for (const stmt of statements) {
            await conn.execute(stmt);
        }
        await conn.execute(SEED_GARMENTS);
        console.log("✅ Database schema ready");
    } finally {
        conn.release();
    }
}