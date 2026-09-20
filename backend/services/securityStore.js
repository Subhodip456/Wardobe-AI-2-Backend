const { createHash, randomBytes, randomUUID } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');

function createSecurityStore(db) {
  const sessions = db.collection('app_sessions');
  const limits = db.collection('request_limits');
  return {
    async ensureIndexes() {
      await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await limits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    },
    async createSession() {
      const token = randomBytes(32).toString('hex');
      const subject = randomUUID();
      const expiresAt = new Date(Date.now() + 365 * 86400000);
      await sessions.insertOne({ _id: hash(token), subject, expiresAt, createdAt: new Date() });
      return { token, subject, expiresAt: expiresAt.toISOString() };
    },
    async authenticate(token) {
      // TTL cleanup is asynchronous: expiry must also be enforced in the query.
      return sessions.findOne({ _id: hash(token), expiresAt: { $gt: new Date() }, revoked: { $ne: true } });
    },
    async allow(key, limit, windowMs) {
      const bucket = Math.floor(Date.now() / windowMs);
      const id = `${hash(key)}:${bucket}`;
      // Upsert only initializes. Conditional increment enforces the bound atomically.
      try {
        await limits.updateOne({ _id: id }, { $setOnInsert: {
          count: 0, expiresAt: new Date((bucket + 2) * windowMs),
        } }, { upsert: true });
      } catch (error) { if (error.code !== 11000) throw error; }
      const result = await limits.updateOne({ _id: id, count: { $lt: limit } }, { $inc: { count: 1 } });
      return result.modifiedCount === 1;
    },
  };
}

module.exports = { createSecurityStore };
