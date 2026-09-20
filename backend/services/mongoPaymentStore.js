const { MongoClient } = require('mongodb');
const { createSecurityStore } = require('./securityStore');

// Reuse the connection pool across warm Vercel invocations. No connection is
// opened at import time, so health/config routes work before database setup.
let cached;
async function getPaymentStore(env = process.env) {
  const uri = env.MONGODB_URI?.trim();
  const dbName = env.MONGODB_DB_NAME?.trim() || 'wardrobe_ai';
  if (!uri) throw new Error('MongoDB is not configured');
  if (!cached || cached.uri !== uri || cached.dbName !== dbName) {
    const previous = cached;
    const client = new MongoClient(uri, {
      maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
      socketTimeoutMS: 10000, retryReads: true, retryWrites: true,
    });
    const entry = { uri, dbName, client };
    cached = entry;
    entry.promise = (async () => {
      try {
        await client.connect();
        const db = client.db(dbName);
        const orders = db.collection('try_on_payment_orders');
        await orders.createIndex({ deviceId: 1, state: 1, createdAt: 1 });
        const security = createSecurityStore(db);
        await security.ensureIndexes();
        return Object.assign(createMongoPaymentStore(orders), { security });
      } catch (error) {
        if (cached === entry) cached = undefined;
        await client.close().catch(() => {});
        throw error;
      }
    })();
    if (previous) void previous.promise.then(() => previous.client.close()).catch(() => {});
  }
  return cached.promise;
}

function createMongoPaymentStore(orders) {
  return {
    async createOrder(orderId, record) {
      // MongoDB's unique _id makes the Razorpay order the permanent replay key.
      await orders.insertOne({ _id: orderId, ...record, state: 'pending', remaining: 0, createdAt: new Date() });
    },
    async getOrder(orderId) {
      return orders.findOne({ _id: orderId });
    },
    async activateOrder(orderId, deviceId, paymentId, credits) {
      // The payment and its credits live together in one document. A repeated
      // verification cannot refill an already-paid (even exhausted) pack.
      await orders.updateOne({ _id: orderId, deviceId, state: 'pending' }, {
        $set: { state: 'paid', paymentId, remaining: credits, paidAt: new Date() },
      });
    },
    async getCredits(deviceId, billingMode) {
      const totals = await orders.aggregate([
        { $match: { deviceId, billingMode, state: 'paid', remaining: { $gt: 0 } } },
        { $group: { _id: null, credits: { $sum: '$remaining' } } },
      ]).toArray();
      return totals[0]?.credits || 0;
    },
    async consumeCredit(deviceId, billingMode) {
      // Conditional decrement is atomic: concurrent requests cannot spend the
      // last credit twice. No multi-document transactions are required.
      const order = await orders.findOneAndUpdate(
        { deviceId, billingMode, state: 'paid', remaining: { $gt: 0 } },
        { $inc: { remaining: -1 } },
        { sort: { createdAt: 1, _id: 1 }, returnDocument: 'after', includeResultMetadata: false },
      );
      return order !== null;
    },
  };
}

module.exports = { getPaymentStore, createMongoPaymentStore };
