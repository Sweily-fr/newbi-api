import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongoServer;

export async function startMongo() {
  if (mongoServer) return mongoose.connection;
  mongoServer = await MongoMemoryServer.create();
  // Use a per-fork unique db name so parallel vitest forks (which each
  // call startMongo() with their own MongoMemoryServer instance, but
  // historically all defaulted to db "test") cannot accidentally collide
  // on documents seeded from constant ObjectIds (e.g. buildUserId() at
  // module top level). The collision manifested as
  //   MongoServerError: E11000 duplicate key error collection: test.user
  // on the apollo-* integration tests under load.
  const uri = mongoServer.getUri();
  const uniqueDb = `test_${process.pid}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const uriWithDb = uri.replace(/\/[^/?]*(\?|$)/, `/${uniqueDb}$1`);
  await mongoose.connect(uriWithDb);
  return mongoose.connection;
}

export async function stopMongo() {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = undefined;
  }
}

export async function clearMongo() {
  // Drop ALL collections including raw ones (e.g. better-auth: organization, member)
  // not tracked by mongoose.connection.collections.
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
