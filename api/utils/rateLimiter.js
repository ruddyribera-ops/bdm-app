// Shared rate limiter utility
// Simple in-memory rate limiter for API endpoints

const limiters = new Map();

/**
 * Create a rate limiter middleware
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {function} Express middleware
 */
export function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    
    let record = limiters.get(key);
    
    if (!record || now - record.firstAttempt > windowMs) {
      // New or expired record
      limiters.set(key, { count: 1, firstAttempt: now });
      return next();
    }
    
    if (record.count >= maxRequests) {
      const waitMs = windowMs - (now - record.firstAttempt);
      const waitSec = Math.ceil(waitMs / 1000);
      console.warn(`Rate limit exceeded for ${key}. Retry after ${waitSec}s`);
      return res.status(429).json({ 
        error: `Demasiadas solicitudes. Espere ${waitSec} segundo(s).`,
        retryAfter: waitSec
      });
    }
    
    record.count++;
    limiters.set(key, record);
    next();
  };
}

/**
 * Clean up expired entries (call periodically)
 */
export function cleanupLimiter() {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute default cleanup
  for (const [key, record] of limiters.entries()) {
    if (now - record.firstAttempt > windowMs * 2) {
      limiters.delete(key);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupLimiter, 5 * 60 * 1000);
