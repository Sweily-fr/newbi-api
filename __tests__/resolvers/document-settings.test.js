/**
 * Paramètres des documents (notes et lien des conditions par défaut) :
 * enregistrés par l'espace, relus à l'identique, et une valeur refusée par
 * le modèle est expliquée (quel champ, pourquoi). Réservés aux rôles qui
 * modifient les paramètres de l'entreprise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import DocumentSettings from "../../src/models/DocumentSettings.js";
import documentSettingsResolvers from "../../src/resolvers/documentSettings.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const ctx = (userId = owner) => buildContext({ userId, organizationId: String(workspaceId) });
const { saveDocumentSettings } = documentSettingsResolvers.Mutation;
const { getDocumentSettings } = documentSettingsResolvers.Query;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({ userId: editor, organizationId: workspaceId, role: "member" });
});

describe("saveDocumentSettings", () => {
  it("lien des conditions invalide : refusé avec le message du champ, rien d'enregistré", async () => {
    await expect(
      saveDocumentSettings(
        null,
        { input: { documentType: "QUOTE", defaultTermsAndConditionsLink: "javascript:alert(1)" } },
        ctx(),
      ),
    ).rejects.toThrow(/URL valide pour le lien des conditions générales/);
    expect(await DocumentSettings.countDocuments({})).toBe(0);
  });

  it("valeurs valides : enregistrées puis relues", async () => {
    const values = {
      defaultHeaderNotes: "Devis valable 30 jours",
      defaultTermsAndConditionsLink: "https://www.exemple.fr/cgv",
    };
    await saveDocumentSettings(null, { input: { documentType: "QUOTE", ...values } }, ctx());
    const settings = await getDocumentSettings(null, { documentType: "QUOTE" }, ctx());
    expect(settings).toMatchObject(values);
  });

  it("Éditeur : refusé (paramètres de l'entreprise)", async () => {
    await expect(
      saveDocumentSettings(null, { input: { documentType: "QUOTE", defaultHeaderNotes: "Notes de l'Éditeur" } }, ctx(editor)),
    ).rejects.toThrow(/permission/i);
    expect(await DocumentSettings.countDocuments({})).toBe(0);
  });
});
