import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext } from "../helpers/auth.js";
import { buildUserId } from "../factories/index.js";

import FileTransfer from "../../src/models/FileTransfer.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertTransferIn({ userId, options = {} }) {
  const _id = new mongoose.Types.ObjectId();
  const now = new Date();

  const doc = {
    _id,
    userId,
    shareLink:
      options.shareLink || "fake-share-link-" + _id.toString().slice(-8),
    accessKey:
      options.accessKey || "fake-access-key-" + _id.toString().slice(-8),
    downloadLink: "fake-download-" + _id.toString().slice(-8),
    files: options.files || [],
    totalSize: options.totalSize || 0,
    expiryDate:
      options.expiryDate || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    status: options.status || "active",
    createdAt: now,
    updatedAt: now,
    workspaceId: options.workspaceId || null,
  };

  await FileTransfer.collection.insertOne(doc);
  return doc;
}

function ctxFor(userId) {
  return buildContext({
    userId,
    organizationId: new mongoose.Types.ObjectId(),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let userA, userB;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  userA = buildUserId();
  userB = buildUserId();
});

// ---------------------------------------------------------------------------
// User-level isolation tests
// ---------------------------------------------------------------------------

describe("FileTransfer — user-level isolation", () => {
  // Test 1 — fileTransferById cross-user deny
  it("user A cannot read user B's transfer by ID", async () => {
    const docB = await insertTransferIn({ userId: userB });

    const resolver = fileTransferResolvers.Query.fileTransferById;

    await expect(
      resolver(null, { id: docB._id.toString() }, ctxFor(userA)),
    ).rejects.toThrow();
  });

  // Test 2 — myFileTransfers scoping
  it("user A only sees own transfers in myFileTransfers", async () => {
    await insertTransferIn({ userId: userA });
    await insertTransferIn({ userId: userB });

    const resolver = fileTransferResolvers.Query.myFileTransfers;
    const result = await resolver(null, { page: 1, limit: 10 }, ctxFor(userA));

    expect(result.items).toHaveLength(1);
    expect(result.totalItems).toBe(1);
    expect(result.items[0].userId.toString()).toBe(userA.toString());
  });

  // Test 3 — deleteFileTransfer cross-user deny
  it("user A cannot delete user B's transfer", async () => {
    const docB = await insertTransferIn({ userId: userB });

    const resolver = fileTransferResolvers.Mutation.deleteFileTransfer;

    await expect(
      resolver(null, { id: docB._id.toString() }, ctxFor(userA)),
    ).rejects.toThrow();

    // Verify doc is NOT soft-deleted (status stays "active")
    const stillExists = await FileTransfer.findById(docB._id);
    expect(stillExists).not.toBeNull();
    expect(stillExists.status).toBe("active");
  });

  // Test 4 — getFileTransferByLink wrong accessKey
  it("getFileTransferByLink with wrong accessKey returns failure", async () => {
    await insertTransferIn({
      userId: userA,
      options: {
        shareLink: "real-share-link-001",
        accessKey: "real-access-key-001",
      },
    });

    const resolver = fileTransferResolvers.Query.getFileTransferByLink;
    const result = await resolver(
      null,
      {
        shareLink: "real-share-link-001",
        accessKey: "wrong-access-key",
      },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.fileTransfer).toBeNull();
  });

  // Test 5 — getFileTransferByLink expired transfer
  it("getFileTransferByLink with expired transfer returns failure", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await insertTransferIn({
      userId: userA,
      options: {
        shareLink: "real-share-link-002",
        accessKey: "real-access-key-002",
        expiryDate: past,
      },
    });

    const resolver = fileTransferResolvers.Query.getFileTransferByLink;
    const result = await resolver(
      null,
      {
        shareLink: "real-share-link-002",
        accessKey: "real-access-key-002",
      },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.fileTransfer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sprint 10 mechanism tests
// ---------------------------------------------------------------------------

describe("FileTransfer — Sprint 10 mechanisms", () => {
  // Test 6 — generateShareCredentials produces crypto-random tokens
  it("generateShareCredentials produces 32-char hex shareLink and accessKey", async () => {
    const doc = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: new Date(Date.now() + 86400000),
      shareLink: "placeholder",
      accessKey: "placeholder",
      downloadLink: "placeholder",
    });

    doc.generateShareCredentials();

    expect(doc.shareLink).toHaveLength(32);
    expect(doc.accessKey).toHaveLength(32);
    expect(doc.downloadLink).toHaveLength(32);
    // Verify hex format
    expect(/^[a-f0-9]{32}$/.test(doc.shareLink)).toBe(true);
    expect(/^[a-f0-9]{32}$/.test(doc.accessKey)).toBe(true);
  });

  // Test 7 — each call generates unique tokens
  it("generateShareCredentials produces unique tokens across calls", () => {
    const doc1 = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: new Date(Date.now() + 86400000),
      shareLink: "p1",
      accessKey: "p1",
      downloadLink: "p1",
    });
    const doc2 = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: new Date(Date.now() + 86400000),
      shareLink: "p2",
      accessKey: "p2",
      downloadLink: "p2",
    });

    doc1.generateShareCredentials();
    doc2.generateShareCredentials();

    expect(doc1.shareLink).not.toBe(doc2.shareLink);
    expect(doc1.accessKey).not.toBe(doc2.accessKey);
  });

  // Test 8 — password is bcrypt-hashed on save
  it("password is bcrypt-hashed on save (not plaintext)", async () => {
    const plainPassword = "MySecret123!";

    const doc = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: new Date(Date.now() + 86400000),
      password: plainPassword,
      shareLink: "test-link-pwd",
      accessKey: "test-key-pwd",
      downloadLink: "test-download-pwd",
    });

    await doc.save();

    // pre-save hook should have bcrypt-hashed the password
    expect(doc.password).not.toBe(plainPassword);
    expect(doc.password.startsWith("$2")).toBe(true);

    // verifyPassword should work
    const valid = await doc.verifyPassword(plainPassword);
    expect(valid).toBe(true);

    const invalid = await doc.verifyPassword("wrong-password");
    expect(invalid).toBe(false);
  });

  // Test 9 — isExpired() method
  it("isExpired returns true for past expiryDate, false for future", () => {
    const past = new Date(Date.now() - 86400000);
    const future = new Date(Date.now() + 86400000);

    const docPast = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: past,
      shareLink: "t1",
      accessKey: "t1",
      downloadLink: "t1",
    });

    const docFuture = new FileTransfer({
      userId: userA,
      files: [],
      totalSize: 0,
      expiryDate: future,
      shareLink: "t2",
      accessKey: "t2",
      downloadLink: "t2",
    });

    expect(docPast.isExpired()).toBe(true);
    expect(docFuture.isExpired()).toBe(false);
  });
});
