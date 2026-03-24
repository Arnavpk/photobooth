// middleware/errorHandler.js
// Central error handler — must be the last app.use() in server.js

export function errorHandler(err, req, res, _next) {
    const status = err.status || 500;
    console.error(`[${req.method}] ${req.path} →`, err.message);
    res.status(status).json({
        error: err.message || "Internal server error",
        ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    });
}