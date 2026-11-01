/**
 * Invitations de signature électronique : 1 à 5 signataires valides et
 * distincts, chacun ne reçoit que son propre lien, et toutes les valeurs
 * saisies sont échappées dans le HTML de l'e-mail.
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
import mongoose from "mongoose";

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {},
}));
vi.mock("../../src/services/esignatureService.js", () => ({
  default: {
    buildCallbackConfig: vi.fn(() => ({})),
    createSESSignature: vi.fn(),
    deleteSignature: vi.fn(),
  },
}));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "resend-1" })));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import esignatureService from "../../src/services/esignatureService.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import Quote from "../../src/models/Quote.js";
import esignatureResolvers from "../../src/resolvers/esignatureResolvers.js";
import { sendSignatureInvitations } from "../../src/services/esignatureEmail.js";
import {
  normalizeSigners,
  MAX_SIGNERS,
} from "../../src/utils/signatureSigners.js";

const { ObjectId } = mongoose.Types;

const LIEN = '<a href="https://exemple.invalid/payer">Régler</a>';
const signer = (i, extra = {}) => ({
  name: "Jean",
  surname: `Client ${i}`,
  email: `client${i}@exemple.fr`,
  ...extra,
});

describe("normalizeSigners", () => {
  it(`accepte de 1 à ${MAX_SIGNERS} signataires et retire les espaces`, () => {
    expect(
      normalizeSigners([
        { name: " Jean ", surname: " Dupont ", email: " jean@exemple.fr " },
      ]),
    ).toEqual([{ name: "Jean", surname: "Dupont", email: "jean@exemple.fr" }]);
    const max = Array.from({ length: MAX_SIGNERS }, (_, i) => signer(i));
    expect(normalizeSigners(max)).toHaveLength(MAX_SIGNERS);
  });

  it("garde les autres champs (téléphone, authentification)", () => {
    const [result] = normalizeSigners([
      signer(1, { mobile: "+33612345678", authentication: ["email", "sms"] }),
    ]);
    expect(result.mobile).toBe("+33612345678");
    expect(result.authentication).toEqual(["email", "sms"]);
  });

  it.each([
    ["aucun signataire", []],
    [
      `plus de ${MAX_SIGNERS} signataires`,
      Array.from({ length: MAX_SIGNERS + 1 }, (_, i) => signer(i)),
    ],
    ["un nom avec du HTML", [signer(1, { name: LIEN })]],
    ["un prénom vide", [signer(1, { name: "  " })]],
    ["un nom trop long", [signer(1, { surname: "a".repeat(101) })]],
    ["une adresse invalide", [signer(1, { email: "pas-une-adresse" })]],
    [
      "une liste d'adresses",
      [signer(1, { email: "a@exemple.fr, b@exemple.fr" })],
    ],
    [
      "deux fois la même adresse",
      [signer(1), signer(2, { email: "CLIENT1@exemple.fr" })],
    ],
  ])("refuse %s", (_label, signers) => {
    expect(() => normalizeSigners(signers)).toThrow();
  });
});

describe("e-mail d'invitation : valeurs échappées", () => {
  beforeEach(() => sendEmail.mockClear());

  it("nom du signataire, numéro du devis et entreprise", async () => {
    await sendSignatureInvitations({
      signerUrls: [
        {
          email: "client@exemple.fr",
          name: LIEN,
          surname: "<b>x</b>",
          url: "https://sign.test/abc?a=1&b=2",
        },
      ],
      companyName: "<i>Entreprise</i>",
      documentNumber: "<a href=http://e.co>-000042",
      totalAmount: "<b>1 200 €</b>",
    });
    const { html } = sendEmail.mock.calls[0][0];
    expect(html).not.toContain('<a href="https://exemple.invalid');
    expect(html).not.toContain("<a href=http://e.co>");
    expect(html).not.toContain("<i>Entreprise</i>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;a href=&quot;https://exemple.invalid/payer");
    expect(html).toContain("&lt;a href=http://e.co&gt;-000042");
    expect(html).toContain('href="https://sign.test/abc?a=1&amp;b=2"');
  });

  it("image piégée, script et préfixe en HTML : échappés, sujet en texte brut", async () => {
    await sendSignatureInvitations({
      signerUrls: [
        {
          email: "client@exemple.fr",
          name: "<img src=x onerror=alert(1)>",
          surname: "O'Connor",
          url: "https://sign.test/abc",
        },
      ],
      companyName: "A&B <script>alert(1)</script>",
      documentNumber: "<b>D</b>-000042",
    });
    const { html, subject } = sendEmail.mock.calls[0][0];
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>D</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("A&amp;B &lt;script&gt;");
    expect(html).toContain("&lt;b&gt;D&lt;/b&gt;-000042");
    // Le sujet n'est pas du HTML : valeurs reprises telles quelles
    expect(subject).toBe(
      "A&B <script>alert(1)</script> vous invite à signer le devis <b>D</b>-000042",
    );
  });

  it("un lien qui n'est pas http(s) n'entre pas dans le HTML", async () => {
    await sendSignatureInvitations({
      signerUrls: [
        {
          email: "client@exemple.fr",
          name: "Jean",
          url: "javascript:alert(1)",
        },
      ],
      companyName: "Entreprise",
      documentNumber: "D-000042",
      trackingPixelUrl: "data:image/png;base64,AAAA",
    });
    const { html } = sendEmail.mock.calls[0][0];
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
  });
});

describe("requestDocumentSignature", () => {
  const userId = buildUserId();
  const organizationId = buildOrganizationId();
  const ctx = () =>
    buildContext({ userId, organizationId: organizationId.toString() });

  let quoteId;

  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
    invalidateOrgCache();
    vi.clearAllMocks();
    await seedOrgMembership({ userId, organizationId, role: "owner" });
    quoteId = new ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      status: "PENDING",
      prefix: "D",
      number: "000042",
      companyInfo: { name: "Entreprise" },
    });
  });

  const request = (signers) =>
    esignatureResolvers.Mutation.requestDocumentSignature(
      null,
      {
        input: {
          documentType: "quote",
          documentId: quoteId.toString(),
          signers,
          documentBase64: "JVBERi0=",
        },
      },
      ctx(),
    );

  it(`refuse plus de ${MAX_SIGNERS} signataires sans appeler le prestataire`, async () => {
    const signers = Array.from({ length: MAX_SIGNERS + 1 }, (_, i) =>
      signer(i),
    );
    await expect(request(signers)).rejects.toThrow(
      new RegExp(`${MAX_SIGNERS} signataires au plus`),
    );
    expect(esignatureService.createSESSignature).not.toHaveBeenCalled();
    expect(await SignatureRequest.countDocuments({ documentId: quoteId })).toBe(
      0,
    );
  });

  it("refuse une adresse invalide sans appeler le prestataire", async () => {
    await expect(
      request([signer(1, { email: "a@exemple.fr; b@exemple.fr" })]),
    ).rejects.toThrow(/adresse e-mail invalide/);
    expect(esignatureService.createSESSignature).not.toHaveBeenCalled();
  });

  it("chaque signataire ne reçoit que son propre lien", async () => {
    esignatureService.createSESSignature.mockResolvedValue({
      data: {
        id: "ext-1",
        state: "WAIT_SIGN",
        signers: [
          { email: "client1@exemple.fr", url: "https://sign.test/un" },
          { email: "autre@exemple.fr" },
        ],
      },
    });

    const result = await request([signer(1), signer(2)]);
    expect(result.success).toBe(true);

    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0][0].to).toBe("client1@exemple.fr");
    const saved = await SignatureRequest.findOne({ documentId: quoteId });
    expect(saved.signers[1].signingUrl).toBeNull();
  });

  it("un signataire unique reçoit l'URL générale de la demande", async () => {
    esignatureService.createSESSignature.mockResolvedValue({
      data: {
        id: "ext-2",
        state: "WAIT_SIGN",
        signingUrl: "https://sign.test/general",
        signers: [],
      },
    });

    await request([signer(1)]);
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    expect(sendEmail.mock.calls[0][0].html).toContain(
      "https://sign.test/general",
    );
  });
});
