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
