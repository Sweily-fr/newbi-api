/**
 * Campagnes e-mail, blocs reliés aux autres outils : signatures de l'outil
 * Signatures de mail (rendues par son générateur, cloisonnées par espace,
 * jamais d'erreur) et destinations du bouton « Lien vers » (pages de
 * rendez-vous publiables, types actifs, événements à venir, rien sans
 * accès à la prise de rendez-vous).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Lu à l'import (adresse publique des pages de rendez-vous)
vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://www.newbi.fr";
});
const assets = vi.hoisted(() => ({
  ensureIcons: vi.fn(async () => {}),
  ensureRoundPhoto: vi.fn(async () => null),
  roundPhotoUrl: vi.fn(() => null),
}));
vi.mock("../../../src/services/signatureAssets.js", () => assets);

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";
import AppointmentType from "../../../src/models/AppointmentType.js";
import BookingPage from "../../../src/models/BookingPage.js";
import EmailSignatureV2 from "../../../src/models/EmailSignatureV2.js";
import { listCampaignLinkTargets } from "../../../src/services/emailCampaigns/linkTargets.js";
import {
  frozenSignatures,
  loadCampaignSignatures,
  loadSignaturesByIds,
  missingSignatureCount,
  renderCampaignSignature,
  signatureIdsOf,
} from "../../../src/services/emailCampaigns/signatures.js";

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const userId = buildUserId();

const signature = (overrides = {}) =>
  EmailSignatureV2.create({
    name: "Ma signature",
    workspaceId,
    createdBy: userId,
    identity: { firstName: "Jean", lastName: "Dupont", jobTitle: "Gérant" },
    contact: { email: "jean@atelier.fr", website: "https://atelier.fr" },
    ...overrides,
  });

const design = (blocks) => ({ version: 1, blocks });

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EmailSignatureV2.init(),
    BookingPage.init(),
    AppointmentType.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  vi.stubEnv("BETA_FEATURES", "none");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signatures des campagnes", () => {
  it("identifiants choisis, sans doublon ni bloc vide", () => {
    const id = "65a1b2c3d4e5f6a7b8c9d0e2";
    const content = design([
      { type: "signature", signatureId: id },
      { type: "signature", signatureId: id.toUpperCase() },
      { type: "signature", signatureId: "" },
      { type: "text", html: "<p>x</p>" },
    ]);
    expect(signatureIdsOf(content)).toEqual([id]);
    expect(signatureIdsOf("illisible")).toEqual([]);
    // Bloc vide et signature non rendue : 3 blocs qui n'afficheront rien
    expect(missingSignatureCount(content, {})).toBe(3);
    expect(missingSignatureCount(content, { [id]: { html: "<table>" } })).toBe(
      1,
    );
  });

  it("rendu du générateur des signatures, icônes préparées", async () => {
    const doc = await signature();
    const { html, text } = await renderCampaignSignature(doc);
    expect(html).toContain("<table");
    expect(html).toContain("Jean");
    expect(html).toContain("Dupont");
    expect(html).toContain('href="mailto:jean@atelier.fr"');
    expect(text).toContain("Jean Dupont");
    expect(assets.ensureIcons).toHaveBeenCalled();
  });

  it("ne lève jamais : rendu vide en cas d'échec", async () => {
    assets.ensureIcons.mockImplementationOnce(async () => {
      throw new Error("R2 indisponible");
    });
    const doc = await signature();
    expect((await renderCampaignSignature(doc)).html).toContain("Jean");
    expect(await renderCampaignSignature({ style: 42 })).toMatchObject({
      text: expect.any(String),
    });
  });

  it("cloisonnées par espace, identifiants inconnus ignorés", async () => {
    const mine = await signature();
    const foreign = await signature({
      workspaceId: otherWorkspace,
      name: "Autre",
    });
    const result = await loadSignaturesByIds(workspaceId, [
      String(mine._id),
      String(foreign._id),
      "pas-un-id",
      "65a1b2c3d4e5f6a7b8c9d0e9",
    ]);
    expect(Object.keys(result)).toEqual([String(mine._id)]);
    expect(result[String(mine._id)]).toMatchObject({
      name: "Ma signature",
      html: expect.stringContaining("Dupont"),
    });
    expect(await loadSignaturesByIds(workspaceId, [])).toEqual({});
    expect(await loadSignaturesByIds(null, [String(mine._id)])).toEqual({});

    const content = design([
      { type: "signature", signatureId: String(mine._id) },
      { type: "signature", signatureId: String(foreign._id) },
    ]);
    const loaded = await loadCampaignSignatures(workspaceId, content);
    expect(Object.keys(loaded)).toEqual([String(mine._id)]);
    expect(missingSignatureCount(content, loaded)).toBe(1);
    // Version figée au lancement : HTML et texte seulement
    expect(frozenSignatures(loaded)).toEqual({
      [String(mine._id)]: {
        html: loaded[String(mine._id)].html,
        text: loaded[String(mine._id)].text,
      },
    });
  });
});

describe("destinations du bouton (« Lien vers »)", () => {
  const now = new Date("2026-11-26T10:00:00Z");

  async function seedPages() {
    const page = await BookingPage.create({
      workspaceId,
      userId,
      slug: "atelier-durand",
      title: "Atelier Durand",
    });
    const closed = await BookingPage.create({
      workspaceId,
      userId: buildUserId(),
      slug: "page-fermee",
      title: "Page fermée",
    });
    await BookingPage.create({
      workspaceId,
      userId: buildUserId(),
      slug: "page-inactive",
      title: "Page désactivée",
      isActive: false,
    });
    await BookingPage.create({
      workspaceId: otherWorkspace,
      userId: buildUserId(),
      slug: "autre-espace",
      title: "Autre espace",
    });
    const type = (overrides) =>
      AppointmentType.create({
        workspaceId,
        bookingPageId: page._id,
        userId,
        durationMinutes: 30,
        location: { kind: "PHONE" },
        ...overrides,
      });
    await type({ slug: "decouverte", name: "Appel découverte", position: 1 });
    await type({ slug: "bilan", name: "Bilan", position: 0 });
    await type({ slug: "pause", name: "Désactivé", isActive: false });
    await type({
      slug: "atelier-janvier",
      name: "Atelier de janvier",
      kind: "EVENT",
      startAt: new Date("2027-01-15T09:00:00Z"),
      endAt: new Date("2027-01-15T12:00:00Z"),
    });
    await type({
      slug: "atelier-decembre",
      name: "Atelier de décembre",
      kind: "EVENT",
      startAt: new Date("2026-12-10T09:00:00Z"),
      endAt: new Date("2026-12-10T12:00:00Z"),
    });
    await type({
      slug: "atelier-passe",
      name: "Atelier passé",
      kind: "EVENT",
      startAt: new Date("2026-10-10T09:00:00Z"),
      endAt: new Date("2026-10-10T12:00:00Z"),
    });
    return { page, closed };
  }

  it("pages publiables, types actifs dans l'ordre, événements à venir par date", async () => {
    const { page, closed } = await seedPages();
    const isPublishable = vi.fn(
      async (candidate) => String(candidate._id) !== String(closed._id),
    );
    const targets = await listCampaignLinkTargets(workspaceId, {
      now,
      isPublishable,
    });
    expect(isPublishable).toHaveBeenCalledTimes(2);
    expect(
      targets.map(({ kind, label, url }) => ({ kind, label, url })),
    ).toEqual([
      {
        kind: "BOOKING_PAGE",
        label: "Atelier Durand",
        url: "https://www.newbi.fr/rdv/atelier-durand",
      },
      {
        kind: "APPOINTMENT_TYPE",
        label: "Bilan",
        url: "https://www.newbi.fr/rdv/atelier-durand/bilan",
      },
      {
        kind: "APPOINTMENT_TYPE",
        label: "Appel découverte",
        url: "https://www.newbi.fr/rdv/atelier-durand/decouverte",
      },
      {
        kind: "EVENT",
        label: "Atelier de décembre",
        url: "https://www.newbi.fr/rdv/atelier-durand/atelier-decembre",
      },
      {
        kind: "EVENT",
        label: "Atelier de janvier",
        url: "https://www.newbi.fr/rdv/atelier-durand/atelier-janvier",
      },
    ]);
    expect(targets.every((t) => t.pageId === String(page._id))).toBe(true);
    expect(targets.every((t) => t.pageTitle === "Atelier Durand")).toBe(true);
    expect(targets[3].startAt).toEqual(new Date("2026-12-10T09:00:00Z"));
    expect(targets[0].startAt).toBeNull();
  });

  it("vide sans accès à la prise de rendez-vous, sans page ou si le contrôle échoue", async () => {
    await seedPages();
    const isPublishable = vi.fn(async () => true);
    vi.stubEnv("BETA_FEATURES", "appointments");
    vi.stubEnv("BETA_WORKSPACE_IDS", String(otherWorkspace));
    expect(
      await listCampaignLinkTargets(workspaceId, { now, isPublishable }),
    ).toEqual([]);
    expect(isPublishable).not.toHaveBeenCalled();

    vi.stubEnv("BETA_WORKSPACE_IDS", String(workspaceId));
    expect(
      (await listCampaignLinkTargets(workspaceId, { now, isPublishable }))
        .length,
    ).toBe(6);

    expect(
      await listCampaignLinkTargets(buildOrganizationId(), { now }),
    ).toEqual([]);
    expect(await listCampaignLinkTargets("pas-un-id")).toEqual([]);
    expect(
      await listCampaignLinkTargets(workspaceId, {
        now,
        isPublishable: async () => {
          throw new Error("abonnement illisible");
        },
      }),
    ).toEqual([]);
  });

  it("identifiants en texte comme en ObjectId", async () => {
    await seedPages();
    const isPublishable = async () => true;
    const fromString = await listCampaignLinkTargets(String(workspaceId), {
      now,
      isPublishable,
    });
    const fromObjectId = await listCampaignLinkTargets(
      new mongoose.Types.ObjectId(String(workspaceId)),
      { now, isPublishable },
    );
    expect(fromObjectId).toEqual(fromString);
  });
});
