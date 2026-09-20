const { getPaymentStore } = require('../services/mongoPaymentStore');

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100000 ? parsed : fallback;
}

function securityMiddleware({ env = process.env, getStore = getPaymentStore } = {}) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    // Only these read-only config routes are public. No paid API trusts device headers.
    if (req.method === 'GET' && ['/try-on/config', '/payments/config'].includes(path)) return next();
    const registering = req.method === 'POST' && path === '/session';
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization') || '');
    if (!registering && !match) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'A secure app session is required. Update or reopen the app.' });
    try {
      const { security } = await getStore(env);
      const rejectLimit = () => res.set('Retry-After', '60').status(429).json({ code: 'RATE_LIMITED', message: 'Request limit reached. Please try again later.' });
      if (registering) {
        // Global circuit breaker is shared by all Vercel instances. Do not trust
        // caller-supplied forwarding headers as an identity or abuse boundary.
        if (!await security.allow('session:global', boundedLimit(env.SESSION_HOURLY_LIMIT, 100), 3600000)) return rejectLimit();
        return res.status(201).json(await security.createSession());
      }
      const session = await security.authenticate(match[1]);
      if (!session) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'This session expired or was revoked. Contact support to recover paid credits.' });
      req.auth = { subject: session.subject };
      if (!await security.allow(`api:${session.subject}`, 60, 60000)) return rejectLimit();
      if (req.method === 'POST') {
        const ai = ['/try-on', '/wardrobe/tag', '/outfit/generate'].includes(path);
        if (!await security.allow(`write:${session.subject}`, 10, 60000)) return rejectLimit();
        if (ai && (!await security.allow(`ai:${session.subject}`, 50, 86400000) ||
          !await security.allow('ai:global', boundedLimit(env.AI_DAILY_REQUEST_LIMIT, 200), 86400000))) return rejectLimit();
        if (path === '/payments/orders' && !await security.allow(`orders:${session.subject}`, 10, 3600000)) return rejectLimit();
      }
      next();
    } catch {
      // No fail-open behavior when MongoDB/limits/session storage is unavailable.
      res.status(503).json({ code: 'SECURITY_UNAVAILABLE', message: 'Secure access is temporarily unavailable. Please try again later.' });
    }
  };
}

module.exports = { securityMiddleware };
