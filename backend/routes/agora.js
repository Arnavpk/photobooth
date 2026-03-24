// routes/agora.js
// Generates short-lived Agora RTC tokens for buyers and salespersons.

import { Router } from "express";
import agoraPkg from "agora-access-token";
const { RtcTokenBuilder, RtcRole } = agoraPkg;

const router = Router();

/**
 * GET /api/agora/token?channel=shopping-room-1&uid=0&role=publisher
 *
 * Returns a signed token valid for 1 hour.
 * uid=0 lets Agora auto-assign a numeric UID.
 * role: "publisher" (can send video) | "subscriber" (receive only)
 */
router.get("/token", (req, res) => {
    const { channel, uid = 0, role = "publisher" } = req.query;

    if (!channel) {
        return res.status(400).json({ error: "channel is required" });
    }

    const appId = process.env.AGORA_APP_ID;
    const appCert = process.env.AGORA_APP_CERTIFICATE;

    // If no certificate is set, return null — Agora allows this in dev mode
    if (!appCert || appCert === "your_agora_app_certificate") {
        return res.json({ token: null, uid: parseInt(uid) || 0 });
    }

    const rtcRole = role === "subscriber" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const expireTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    const token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCert,
        channel,
        parseInt(uid) || 0,
        rtcRole,
        expireTime
    );

    res.json({ token, uid: parseInt(uid) || 0 });
});

export default router;