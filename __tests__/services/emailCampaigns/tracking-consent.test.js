/**
 * Campagnes e-mail, accords de suivi par adresse (recommandation CNIL sur
 * les pixels de suivi) : choix du contact prioritaire sur l'espace, accords
 * saisis par l'espace, refus et retrait qui effacent le suivi de l'adresse
 * dans toutes les campagnes de l'espace (et seulement de cet espace),
 * historique borné.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";
import EmailCampaignClick from "../../../src/models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../../src/models/EmailCampaignRecipient.js";
import EmailTrackingConsent from "../../../src/models/EmailTrackingConsent.js";
import {
  eraseRecipientTracking,
  grantBySender,
  grantedEmailSet,
  recordContactChoice,
  refuseBySender,
  removeSenderConsent,
} from "../../../src/services/emailCampaigns/trackingConsent.js";

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const userId = buildUserId();
const campaignA = new mongoose.Types.ObjectId();
const campaignB = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EmailCampaignRecipient.init(),
    EmailCampaignClick.init(),
    EmailTrackingConsent.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

/** Destinataire suivi qui a ouvert et cliqué. */
async function trackedRecipient(email, campaignId, workspace = workspaceId) {
  const recipient = await EmailCampaignRecipient.create({
    workspaceId: workspace,
    campaignId,
    email,
    status: "DELIVERED",
    trackingAllowed: true,
    openedAt: new Date(),
    openCount: 2,
    clickedAt: new Date(),
    clickCount: 1,
  });
  await EmailCampaignClick.create({
    workspaceId: workspace,
    campaignId,
    recipientId: recipient._id,
    linkIndex: 0,
  });
  return recipient;
}

const consentOf = (email, workspace = workspaceId) =>
  EmailTrackingConsent.findOne({ workspaceId: workspace, email }).lean();

describe("accords de suivi", () => {
  it("accords saisis : contrôlés, dédoublonnés, refus du contact respecté, accord du contact gardé", async () => {
    await EmailTrackingConsent.create([
      {
        workspaceId,
        email: "refus@exemple.fr",
        status: "REFUSED",
        source: "CONTACT",
        decidedAt: new Date(),
      },
      {
        workspaceId,
        email: "oui@exemple.fr",
        status: "GRANTED",
        source: "CONTACT",
        decidedAt: new Date("2026-01-01"),
      },
      {
        workspaceId,
        email: "ancien@exemple.fr",
        status: "REFUSED",
        source: "SENDER",
        decidedAt: new Date(),
      },
    ]);
    const result = await grantBySender({
      workspaceId,
      emails: [
        "Nouveau@Exemple.fr",
        "nouveau@exemple.fr",
        "",
        "refus@exemple.fr",
        "oui@exemple.fr",
        "ancien@exemple.fr",
      ],
      note: "x".repeat(300),
      userId,
      userName: "Paul Martin",
    });
    expect(result).toEqual({
      granted: 3,
      skipped: [
        { email: "", reason: "INVALID" },
        { email: "refus@exemple.fr", reason: "CONTACT_REFUSED" },
      ],
    });
    const nouveau = await consentOf("nouveau@exemple.fr");
    expect(nouveau).toMatchObject({
      status: "GRANTED",
      source: "SENDER",
      decidedByName: "Paul Martin",
    });
    expect(nouveau.note).toHaveLength(200);
    // Choix du contact gardé tel quel
    expect(await consentOf("oui@exemple.fr")).toMatchObject({
      source: "CONTACT",
      decidedAt: new Date("2026-01-01"),
    });
    // Refus saisi par l'espace : remplacé par l'accord, historique gardé
    const ancien = await consentOf("ancien@exemple.fr");
    expect(ancien).toMatchObject({ status: "GRANTED", source: "SENDER" });
    expect(ancien.history.map((h) => h.status)).toEqual(["GRANTED"]);
    expect(await consentOf("refus@exemple.fr")).toMatchObject({
      status: "REFUSED",
    });
    expect(
      await grantedEmailSet(workspaceId, [
        "NOUVEAU@exemple.fr",
        "oui@exemple.fr",
        "refus@exemple.fr",
        "inconnu@exemple.fr",
      ]),
    ).toEqual(new Set(["nouveau@exemple.fr", "oui@exemple.fr"]));
  });

  it("choix du contact : accepte puis refuse, suivi effacé dans tout l'espace et seulement là", async () => {
    const a = await trackedRecipient("marie@exemple.fr", campaignA);
    const b = await trackedRecipient("marie@exemple.fr", campaignB);
    const elsewhere = await trackedRecipient(
      "marie@exemple.fr",
      new mongoose.Types.ObjectId(),
      otherWorkspace,
    );
    await recordContactChoice(
      { workspaceId, email: "Marie@exemple.fr", campaignId: campaignA },
      "GRANTED",
    );
    expect(await consentOf("marie@exemple.fr")).toMatchObject({
      status: "GRANTED",
      source: "CONTACT",
    });
    await recordContactChoice(
      { workspaceId, email: "marie@exemple.fr", campaignId: campaignB },
      "REFUSED",
    );
    const consent = await consentOf("marie@exemple.fr");
    expect(consent).toMatchObject({ status: "REFUSED", source: "CONTACT" });
    expect(consent.history.map((h) => h.status)).toEqual([
      "GRANTED",
      "REFUSED",
    ]);
    for (const recipient of [a, b]) {
      expect(
        await EmailCampaignRecipient.findById(recipient._id).lean(),
      ).toMatchObject({
        trackingAllowed: false,
        trackingExpired: true,
        openedAt: null,
        openCount: 0,
        clickedAt: null,
        clickCount: 0,
      });
    }
    expect(await EmailCampaignClick.countDocuments({ workspaceId })).toBe(0);
    // Autre espace : intact
    expect(
      await EmailCampaignRecipient.findById(elsewhere._id).lean(),
    ).toMatchObject({ trackingAllowed: true, openCount: 2 });
    expect(
      await EmailCampaignClick.countDocuments({ workspaceId: otherWorkspace }),
    ).toBe(1);
    expect(
      await recordContactChoice({ workspaceId, email: "" }, "GRANTED"),
    ).toBeNull();
  });

  it("refus noté par l'espace : remplace son accord ou celui du contact, garde le refus du contact", async () => {
    await trackedRecipient("luc@exemple.fr", campaignA);
    await recordContactChoice(
      { workspaceId, email: "luc@exemple.fr", campaignId: campaignA },
      "GRANTED",
    );
    const refused = await refuseBySender({
      workspaceId,
      email: "luc@exemple.fr",
      userId,
      userName: "Paul Martin",
    });
    expect(refused).toMatchObject({ status: "REFUSED", source: "SENDER" });
    expect(
      await EmailCampaignRecipient.findOne({ email: "luc@exemple.fr" }).lean(),
    ).toMatchObject({ trackingExpired: true, openCount: 0 });

    await recordContactChoice(
      { workspaceId, email: "ines@exemple.fr", campaignId: campaignA },
      "REFUSED",
    );
    const kept = await refuseBySender({
      workspaceId,
      email: "ines@exemple.fr",
    });
    expect(kept).toMatchObject({ status: "REFUSED", source: "CONTACT" });
  });

  it("retrait : saisies de l'espace seulement, accord retiré = suivi effacé", async () => {
    await trackedRecipient("marie@exemple.fr", campaignA);
    await grantBySender({ workspaceId, emails: ["marie@exemple.fr"] });
    const granted = await consentOf("marie@exemple.fr");
    expect(await removeSenderConsent({ workspaceId, id: granted._id })).toBe(
      "removed",
    );
    expect(await consentOf("marie@exemple.fr")).toBeNull();
    expect(
      await EmailCampaignRecipient.findOne({
        email: "marie@exemple.fr",
      }).lean(),
    ).toMatchObject({ trackingExpired: true, openCount: 0 });

    await recordContactChoice(
      { workspaceId, email: "luc@exemple.fr", campaignId: campaignA },
      "REFUSED",
    );
    const contact = await consentOf("luc@exemple.fr");
    expect(await removeSenderConsent({ workspaceId, id: contact._id })).toBe(
      "contact_choice",
    );
    expect(
      await removeSenderConsent({
        workspaceId: otherWorkspace,
        id: contact._id,
      }),
    ).toBe("not_found");
    expect(await consentOf("luc@exemple.fr")).not.toBeNull();
  });

  it("historique borné aux 20 derniers changements", async () => {
    for (let i = 0; i < 25; i += 1) {
      await recordContactChoice(
        { workspaceId, email: "va-et-vient@exemple.fr", campaignId: campaignA },
        i % 2 ? "REFUSED" : "GRANTED",
      );
    }
    const consent = await consentOf("va-et-vient@exemple.fr");
    expect(consent.history).toHaveLength(20);
    expect(consent.status).toBe("GRANTED");
    expect(
      await eraseRecipientTracking(workspaceId, "personne@exemple.fr"),
    ).toBe(0);
  });
});

describe("mongoose", () => {
  it("base de test seulement", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
