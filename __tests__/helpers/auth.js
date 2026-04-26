import mongoose from "mongoose";

const { ObjectId } = mongoose.Types;

/**
 * Seed a better-auth organization + member document directly in raw collections.
 * RBAC reads from the "organization" and "member" collections via mongoose.connection.db.
 */
export async function seedOrgMembership({
  userId,
  organizationId,
  role = "owner",
  organizationName = "Test Org",
  withCompanyInfo = true,
  subscriptionStatus = "active",
}) {
  const db = mongoose.connection.db;

  const userObjectId =
    typeof userId === "string" ? new ObjectId(userId) : userId;
  const orgObjectId =
    typeof organizationId === "string"
      ? new ObjectId(organizationId)
      : organizationId;

  const companyInfo = withCompanyInfo
    ? {
        companyName: organizationName,
        companyEmail: "contact@test.fr",
        addressStreet: "1 rue du Test",
        addressCity: "Paris",
        addressZipCode: "75001",
        addressCountry: "France",
        siret: "12345678901234",
        legalForm: "SASU",
      }
    : {};

  // Upsert org so the same org can be reused across multiple memberships
  await db.collection("organization").updateOne(
    { _id: orgObjectId },
    {
      $setOnInsert: {
        _id: orgObjectId,
        name: organizationName,
        slug: organizationName.toLowerCase().replace(/\s+/g, "-"),
        createdAt: new Date(),
        ...companyInfo,
      },
    },
    { upsert: true },
  );

  await db.collection("member").updateOne(
    { userId: userObjectId, organizationId: orgObjectId },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        userId: userObjectId,
        organizationId: orgObjectId,
        role,
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Seed a subscription so that checkSubscriptionActive allows write mutations.
  // Tests that need a different status can pass subscriptionStatus: "expired" etc.
  if (subscriptionStatus) {
    await db.collection("subscription").updateOne(
      { referenceId: orgObjectId.toString() },
      {
        $setOnInsert: {
          referenceId: orgObjectId.toString(),
          status: subscriptionStatus,
          plan: "pme",
          seats: 10,
          periodStart: new Date(),
          periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          cancelAtPeriodEnd: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  return { userId: userObjectId, organizationId: orgObjectId, role };
}

/**
 * Build a GraphQL resolver context that mimics the one assembled in server.js,
 * with the user authenticated and an organization header set.
 */
export function buildContext({ userId, organizationId, extra = {} } = {}) {
  const userObjectId =
    typeof userId === "string" ? new ObjectId(userId) : userId;
  const orgString =
    typeof organizationId === "string"
      ? organizationId
      : organizationId.toString();

  return {
    user: {
      _id: userObjectId,
      id: userObjectId.toString(),
      email: "test@test.com",
      name: "Test User",
    },
    workspaceId: orgString,
    req: {
      headers: {
        "x-organization-id": orgString,
      },
    },
    ...extra,
  };
}
