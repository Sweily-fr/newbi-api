import mongoose from "mongoose";
import { faker } from "@faker-js/faker/locale/fr";

const { ObjectId } = mongoose.Types;

faker.seed(1);

const valid9Digits = () => faker.string.numeric(9);
const valid14Digits = () => faker.string.numeric(14);

const sanitizeName = (raw) => {
  // Strip characters not allowed by the Client schema's NAME_REGEX
  return raw.replace(/[^a-zA-ZÀ-ÿ\s'-]/g, "").slice(0, 40) || "Test Client";
};

export function buildOrganizationId() {
  return new ObjectId();
}

export function buildUserId() {
  return new ObjectId();
}

export function buildAddress(overrides = {}) {
  return {
    street: "1 rue de Test",
    city: "Paris",
    postalCode: "75001",
    country: "France",
    ...overrides,
  };
}

export function buildClientInput(overrides = {}) {
  const type = overrides.type || "COMPANY";
  const base =
    type === "COMPANY"
      ? {
          name: sanitizeName(faker.company.name()),
          email: faker.internet.email().toLowerCase(),
          type: "COMPANY",
          siret: valid14Digits(),
          isInternational: false,
          address: buildAddress(),
        }
      : {
          email: faker.internet.email().toLowerCase(),
          type: "INDIVIDUAL",
          firstName: sanitizeName(faker.person.firstName()),
          lastName: sanitizeName(faker.person.lastName()),
          address: buildAddress(),
        };
  return { ...base, ...overrides };
}

export function buildClientDoc({ workspaceId, createdBy, ...overrides } = {}) {
  if (!workspaceId) workspaceId = buildOrganizationId();
  if (!createdBy) createdBy = buildUserId();

  return {
    ...buildClientInput(overrides),
    workspaceId,
    createdBy,
  };
}

export function buildInvoiceItem(overrides = {}) {
  return {
    description: faker.commerce.productName(),
    quantity: 1,
    unitPrice: 100,
    vatRate: 20,
    discount: 0,
    discountType: "FIXED",
    ...overrides,
  };
}

export function buildInvoiceInput(overrides = {}) {
  return {
    items: [buildInvoiceItem()],
    discount: 0,
    discountType: "FIXED",
    shipping: null,
    isReverseCharge: false,
    ...overrides,
  };
}

export function buildProductInput(overrides = {}) {
  return {
    name: sanitizeName(faker.commerce.productName()),
    description: "Test product",
    unitPrice: 100,
    vatRate: 20,
    unit: "unit",
    ...overrides,
  };
}

/**
 * Builds a Better Auth user document ready to insert into MongoDB.
 *
 * IMPORTANT: This factory is for backend resolver tests where the user is
 * injected directly into the GraphQL context (no real login flow).
 *
 * Do NOT use this if your test needs to perform a real login via
 * /api/auth/sign-in/email — Better Auth uses scrypt (not bcrypt) and
 * inserting a hashed password manually here would not match.
 * For login flows, use the HTTP signup endpoint instead.
 *
 * @param {object} overrides - Fields to override defaults
 * @returns {object} A Better Auth-compatible user document
 *
 * @example
 *   const user = buildUserDoc({ email: "alice@test.com" });
 *   await mongoose.connection.db.collection("user").insertOne(user);
 */
export function buildUserDoc(overrides = {}) {
  const _id = overrides._id ?? new ObjectId();
  const now = overrides.createdAt ?? new Date();

  const firstName = overrides.firstName ?? faker.person.firstName();
  const lastName = overrides.lastName ?? faker.person.lastName();

  return {
    _id,
    id: _id.toString(),
    email: faker.internet.email({ firstName, lastName }).toLowerCase(),
    emailVerified: true,
    name: `${firstName} ${lastName}`,
    image: null,
    createdAt: now,
    updatedAt: now,
    firstName,
    lastName,
    phoneNumber: null,
    phoneNumberVerified: false,
    twoFactorEnabled: false,
    role: "user",
    banned: false,
    banReason: null,
    banExpires: null,
    ...overrides,
  };
}

/**
 * Builds an account document (Better Auth credentials side).
 * Required if your test queries the `account` collection
 * (e.g. checking that a user has a credential entry).
 *
 * Note: leaves `password` undefined — do not attempt scrypt hashing manually.
 */
export function buildAccountDoc({ userId, ...overrides } = {}) {
  if (!userId) {
    throw new Error("buildAccountDoc requires a userId");
  }
  return {
    _id: new ObjectId(),
    userId: userId.toString(),
    providerId: "credential",
    accountId: userId.toString(),
    password: undefined,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    idToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Builds a session document for a given user.
 * Useful for testing session validation middleware.
 */
export function buildSessionDoc({ userId, ...overrides } = {}) {
  if (!userId) {
    throw new Error("buildSessionDoc requires a userId");
  }
  const _id = new ObjectId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    _id,
    id: _id.toString(),
    userId: userId.toString(),
    token: faker.string.alphanumeric(64),
    expiresAt,
    ipAddress: faker.internet.ip(),
    userAgent: faker.internet.userAgent(),
    activeOrganizationId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
