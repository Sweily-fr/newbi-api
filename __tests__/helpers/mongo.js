import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongoServer;

export async function startMongo() {
  if (mongoServer) return mongoose.connection;
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
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
