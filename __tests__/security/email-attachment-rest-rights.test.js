/**
 * Route REST des fichiers joints à la main aux e-mails de documents :
 * « Voir » du document exigé dans l'espace de l'envoi, et seuls les PDF et
 * images s'affichent (les autres formats, choisis par l'utilisateur, sont
 * téléchargés pour ne jamais s'exécuter sur l'origine de l'application).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    validateJWT: (req, res, next) => {
      if (!auth.user) return res.status(401).json({ error: "Non authentifié" });
      req.user = String(auth.user);
      return next();
    },
  };
});
const storage = vi.hoisted(() => ({ getEmailAttachmentBuffer: vi.fn() }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: storage,
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { MODULES } from "../../src/config/rolePermissions.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import DocumentEmailLog from "../../src/models/DocumentEmailLog.js";
import emailAttachmentRoutes from "../../src/routes/emailAttachment.js";

const workspaceId = buildOrganizationId();
const viewer = buildUserId(); // « Membre »
const restricted = buildUserId(); // rôle sans les factures
const outsider = buildUserId(); // hors de l'espace
const ROLE = `role_${"d".repeat(24)}`;
const logId = new mongoose.Types.ObjectId();

let server;
let baseUrl;

const fetchAttachment = (index, id = logId) =>
  fetch(`${baseUrl}/documents/email-logs/${id}/attachment?index=${index}`);

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/documents", emailAttachmentRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  vi.clearAllMocks();
  auth.user = viewer;
  storage.getEmailAttachmentBuffer.mockResolvedValue(Buffer.from("contenu"));
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
  await seedOrgMembership({
    userId: restricted,
    organizationId: workspaceId,
    role: ROLE,
  });
  const actions = Object.fromEntries(MODULES.map((m) => [m.key, ["view"]]));
  actions.invoices = [];
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Sans factures",
    actions,
    permission: "{}",
  });
  await DocumentEmailLog.collection.insertOne({
    _id: logId,
    workspaceId,
    documentType: "invoice",
    documentId: new mongoose.Types.ObjectId(),
    sentAt: new Date(),
    to: "client@test.fr",
    attachments: [
      { filename: "F-001.pdf", size: 8, isDocument: true },
      {
        filename: "devis signé.pdf",
        size: 7,
        isDocument: false,
        storageKey: "email-attachments/k/1-devis-sign-.pdf",
      },
      {
        filename: "page.html",
        size: 7,
        isDocument: false,
        storageKey: "email-attachments/k/2-page.html",
      },
      { filename: "ancien.docx", size: 7, isDocument: false },
    ],
  });
});

describe("fichier joint à un e-mail de document", () => {
  it("s'ouvre dans le navigateur pour un membre (PDF)", async () => {
    const response = await fetchAttachment(1);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(
      /^inline; filename="devis sign_.pdf"; filename\*=UTF-8''devis%20sign%C3%A9\.pdf$/,
    );
    expect(await response.text()).toBe("contenu");
    expect(storage.getEmailAttachmentBuffer).toHaveBeenCalledWith(
      "email-attachments/k/1-devis-sign-.pdf",
    );
  });

  it("télécharge un format qui pourrait s'exécuter (HTML)", async () => {
    const response = await fetchAttachment(2);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuse un rôle sans les factures", async () => {
    auth.user = restricted;
    expect((await fetchAttachment(1)).status).toBe(403);
    expect(storage.getEmailAttachmentBuffer).not.toHaveBeenCalled();
  });

  it("refuse un utilisateur hors de l'espace", async () => {
    auth.user = outsider;
    expect((await fetchAttachment(1)).status).toBe(403);
  });

  it("refuse sans session", async () => {
    auth.user = null;
    expect((await fetchAttachment(1)).status).toBe(401);
  });

  it("fichier non conservé, PDF du document ou index invalide", async () => {
    expect((await fetchAttachment(3)).status).toBe(404);
    expect((await fetchAttachment(0)).status).toBe(404);
    expect((await fetchAttachment(9)).status).toBe(404);
    expect((await fetchAttachment("x")).status).toBe(400);
    expect(
      (await fetchAttachment(1, new mongoose.Types.ObjectId())).status,
    ).toBe(404);
  });
});
