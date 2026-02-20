import express from "express";
import GuideLead from "../models/GuideLead.js";
import Client from "../models/Client.js";
import ClientList from "../models/ClientList.js";
import ClientCustomField from "../models/ClientCustomField.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Rate limiting simple (in-memory, 5 req/min/IP)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Nettoyage périodique de la map (toutes les 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Sanitize basic string input
function sanitize(str) {
  if (typeof str !== "string") return "";
  return str.trim().slice(0, 200);
}

// Email validation simple
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /guide
 * Enregistre un lead pour le téléchargement d'un guide
 */
router.post("/guide", async (req, res) => {
  try {
    logger.info(`[GuideLeads] POST /guide reçu — body: ${JSON.stringify(req.body)}`);

    const ip = req.ip || req.connection?.remoteAddress || "unknown";

    if (!checkRateLimit(ip)) {
      logger.warn(`[GuideLeads] Rate limit atteint pour IP: ${ip}`);
      return res.status(429).json({
        success: false,
        error: "Trop de requêtes. Veuillez réessayer dans une minute.",
      });
    }

    const { firstName, lastName, companyName, email, phone, source, acceptedTerms } = req.body;

    // Validation des champs requis
    if (!firstName || !lastName || !companyName || !email || !phone || !acceptedTerms) {
      logger.warn(`[GuideLeads] Validation échouée — champs manquants: ${JSON.stringify({ firstName: !!firstName, lastName: !!lastName, companyName: !!companyName, email: !!email, phone: !!phone, acceptedTerms: !!acceptedTerms })}`);
      return res.status(400).json({
        success: false,
        error: "Les champs prénom, nom, entreprise, email, téléphone et acceptation des conditions sont requis.",
      });
    }

    const sanitizedEmail = sanitize(email).toLowerCase();
    if (!isValidEmail(sanitizedEmail)) {
      return res.status(400).json({
        success: false,
        error: "Adresse email invalide.",
      });
    }

    const guideSlug = "facturation-electronique";

    // Vérifier si le lead existe déjà (anti-doublon)
    const existingLead = await GuideLead.findOne({ email: sanitizedEmail, guideSlug });
    if (existingLead) {
      logger.info(`[GuideLeads] Lead déjà existant: ${sanitizedEmail} — on tente quand même l'intégration CRM`);
    } else {
      logger.info(`[GuideLeads] Création du lead: ${sanitizedEmail}`);
      // Sauvegarder le lead
      await GuideLead.create({
        firstName: sanitize(firstName),
        lastName: sanitize(lastName),
        companyName: sanitize(companyName),
        email: sanitizedEmail,
        phone: phone ? sanitize(phone) : undefined,
        source: source || undefined,
        guideSlug,
        acceptedTerms: true,
      });
    }

    // Intégration CRM optionnelle
    const workspaceId = process.env.LEADS_WORKSPACE_ID;
    const systemUserId = process.env.LEADS_SYSTEM_USER_ID;

    logger.info(`[GuideLeads] Lead sauvegardé. CRM config: workspaceId=${workspaceId || "NON DÉFINI"}, systemUserId=${systemUserId || "NON DÉFINI"}`);

    if (workspaceId && systemUserId) {
      try {
        // Vérifier si le client existe déjà dans le CRM
        let client = await Client.findOne({ email: sanitizedEmail, workspaceId });
        logger.info(`[GuideLeads] Client existant dans CRM: ${client ? "OUI" : "NON"}`);

        if (!client) {
          // Créer le client dans le CRM
          client = await Client.create({
            name: sanitize(companyName),
            firstName: sanitize(firstName),
            lastName: sanitize(lastName),
            email: sanitizedEmail,
            phone: phone ? sanitize(phone) : undefined,
            type: "COMPANY",
            address: {
              street: "Non renseigné",
              city: "Non renseigné",
              postalCode: "00000",
              country: "France",
            },
            createdBy: systemUserId,
            workspaceId,
            activity: [{
              type: "created",
              description: "Lead créé via le guide facturation électronique",
              userId: systemUserId,
              userName: "Système",
            }],
          });
        }

        // Ajouter "Source" en champ personnalisé si renseigné
        if (source) {
          const sanitizedSource = sanitize(source);
          // Find-or-create le champ personnalisé "Source"
          let sourceField = await ClientCustomField.findOne({
            name: "Source",
            workspaceId,
          });

          if (!sourceField) {
            sourceField = await ClientCustomField.create({
              name: "Source",
              fieldType: "SELECT",
              description: "Comment le lead a connu Newbi",
              options: [
                { label: "Recherche Google", value: "Recherche Google", color: "#3b82f6" },
                { label: "Réseaux sociaux", value: "Réseaux sociaux", color: "#8b5cf6" },
                { label: "Bouche à oreille", value: "Bouche à oreille", color: "#10b981" },
                { label: "Blog / Article", value: "Blog / Article", color: "#f59e0b" },
                { label: "Publicité", value: "Publicité", color: "#ef4444" },
                { label: "Événement / Salon", value: "Événement / Salon", color: "#ec4899" },
                { label: "Autre", value: "Autre", color: "#6b7280" },
              ],
              workspaceId,
              createdBy: systemUserId,
            });
          }

          // Ajouter la valeur du champ personnalisé au client
          const existingFieldIndex = client.customFields.findIndex(
            (cf) => cf.fieldId.toString() === sourceField._id.toString()
          );
          if (existingFieldIndex === -1) {
            client.customFields.push({
              fieldId: sourceField._id,
              value: sanitizedSource,
            });
            await client.save();
          }
        }

        // Find-or-create la liste "Leads Guide Facturation Elec."
        const listName = "Leads Guide Facturation Elec.";
        let clientList = await ClientList.findOne({ name: listName, workspaceId });

        if (!clientList) {
          clientList = await ClientList.create({
            name: listName,
            description: "Leads ayant téléchargé le guide sur la facturation électronique",
            workspaceId,
            createdBy: systemUserId,
            color: "#6366f1",
            icon: "FileText",
          });
        }

        // Ajouter le client à la liste s'il n'y est pas déjà
        if (!clientList.clients.includes(client._id)) {
          clientList.clients.push(client._id);
          await clientList.save();
        }

        logger.info(`[GuideLeads] Lead CRM créé: ${sanitizedEmail} → liste "${listName}"`);
      } catch (crmError) {
        // Ne pas bloquer le téléchargement si le CRM échoue
        logger.error(`[GuideLeads] Erreur CRM (non-bloquante): ${crmError.message}`, { stack: crmError.stack });
      }
    }

    // Notification email via Next.js (Resend)
    const notifyEmails = process.env.LEADS_NOTIFY_EMAILS;
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const internalSecret = process.env.INTERNAL_API_SECRET;

    if (notifyEmails && internalSecret) {
      try {
        const recipients = notifyEmails.split(",").map((e) => e.trim()).filter(Boolean);
        const notifyRes = await fetch(`${frontendUrl}/api/leads/notify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-secret": internalSecret,
          },
          body: JSON.stringify({
            lead: {
              firstName: sanitize(firstName),
              lastName: sanitize(lastName),
              companyName: sanitize(companyName),
              email: sanitizedEmail,
              phone: sanitize(phone),
              source: source ? sanitize(source) : "Non renseigné",
            },
            recipients,
          }),
        });

        if (notifyRes.ok) {
          logger.info(`[GuideLeads] Email de notification envoyé via Next.js à ${recipients.join(", ")}`);
        } else {
          const errBody = await notifyRes.text();
          logger.warn(`[GuideLeads] Erreur email Next.js (${notifyRes.status}): ${errBody}`);
        }
      } catch (emailError) {
        logger.warn(`[GuideLeads] Erreur envoi email (non-bloquante): ${emailError.message}`);
      }
    }

    return res.json({ success: true });
  } catch (error) {
    // Doublon MongoDB (race condition sur l'index unique)
    if (error.code === 11000) {
      return res.json({ success: true });
    }

    logger.error(`[GuideLeads] Erreur: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Une erreur est survenue. Veuillez réessayer.",
    });
  }
});

export default router;
