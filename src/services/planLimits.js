import InvoiceTemplate from "../models/invoiceTemplate.js";
import QuoteTemplate from "../models/quoteTemplate.js";
import AccountBanking from "../models/AccountBanking.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { getWorkspacePlan } from "./esignatureQuota.js";

/**
 * Plafonds des offres que l'API fait respecter (-1 = illimité, false = absent
 * de l'offre). Miroir de PLAN_LIMITS dans NewbiV2/src/lib/plan-limits.js : le
 * site annonce ces plafonds et grise les boutons, l'API les applique quand
 * on l'appelle directement. Les deux doivent bouger ensemble.
 */
export const PLAN_LIMITS = {
  freelance: {
    customFields: 5,
    // Automatisations des documents partagés
    documentAutomations: 5,
    clientSegments: false,
    crmEmailAutomations: false,
    // Modèles de factures et de devis, quota commun
    documentTemplates: 10,
    // Signature simple seulement ; « qes » = signature qualifiée et cachet
    esignature: "ses",
    // Banques connectées (connexions bancaires distinctes)
    bankAccounts: 1,
  },
  pme: {
    customFields: -1,
    documentAutomations: -1,
    clientSegments: true,
    crmEmailAutomations: true,
    documentTemplates: -1,
    esignature: "ses",
    bankAccounts: 3,
  },
  entreprise: {
    customFields: -1,
    documentAutomations: -1,
    clientSegments: true,
    crmEmailAutomations: true,
    documentTemplates: -1,
    esignature: "qes",
    bankAccounts: 5,
  },
};

// Offre qui lève le plafond, telle que le site la nomme (« pme » = TPE)
const NEXT_PLAN_LABEL = {
  freelance: "TPE",
  pme: "Entreprise",
};

export async function getWorkspacePlanLimits(workspaceId) {
  const plan = await getWorkspacePlan(workspaceId);
  return { plan, limits: PLAN_LIMITS[plan] || PLAN_LIMITS.freelance };
}

const upgradeHint = (plan, purpose) =>
  NEXT_PLAN_LABEL[plan]
    ? ` Passez à l'offre ${NEXT_PLAN_LABEL[plan]} pour ${purpose}.`
    : "";

/**
 * Refuse une création au-delà du nombre que l'offre autorise.
 * `countExisting` n'est appelé que si l'offre a un plafond.
 * `what` : ce qui est compté, au pluriel (« champs personnalisés »).
 */
export async function assertPlanCapacity(
  workspaceId,
  limitKey,
  countExisting,
  what,
) {
  const { plan, limits } = await getWorkspacePlanLimits(workspaceId);
  const max = limits[limitKey];
  if (typeof max !== "number" || max < 0) return;
  const count = await countExisting();
  if (count >= max) {
    throw new AppError(
      `Votre offre n'autorise pas plus de ${max} ${what}.${upgradeHint(plan, "en ajouter davantage")}`,
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Refuse une fonctionnalité absente de l'offre.
 * `what` : la fonctionnalité (« les segments de contacts »).
 */
export async function assertPlanFeature(workspaceId, featureKey, what) {
  const { plan, limits } = await getWorkspacePlanLimits(workspaceId);
  if (!limits[featureKey]) {
    throw new AppError(
      `Votre offre ne comprend pas ${what}.${upgradeHint(plan, "en profiter")}`,
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Modèles de documents : quota commun aux factures et aux devis, comme le
 * compte la fenêtre « Sauvegarder comme modèle » du site.
 */
export async function assertDocumentTemplateCapacity(workspaceId) {
  await assertPlanCapacity(
    workspaceId,
    "documentTemplates",
    async () => {
      const [invoices, quotes] = await Promise.all([
        InvoiceTemplate.countDocuments({ workspaceId }),
        QuoteTemplate.countDocuments({ workspaceId }),
      ]);
      return invoices + quotes;
    },
    "modèles de documents",
  );
}

/**
 * Signature qualifiée (QES) et cachet de l'entreprise : offre Entreprise
 * seulement (esignature « qes » dans plan-limits).
 */
export async function assertQualifiedSignatureAllowed(workspaceId) {
  const { limits } = await getWorkspacePlanLimits(workspaceId);
  if (limits.esignature !== "qes") {
    throw new AppError(
      "La signature qualifiée et le cachet de l'entreprise sont réservés à l'offre Entreprise.",
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Banques connectées de l'espace, comptées comme le site les affiche
 * (Paramètres > Comptes bancaires) : comptes actifs regroupés par banque
 * (provider_id, sinon item_id de la connexion, sinon le compte lui-même).
 * Un compte déconnecté ne compte plus.
 */
export async function countConnectedBanks(workspaceId) {
  const accounts = await AccountBanking.find({
    workspaceId: String(workspaceId),
    status: { $in: ["active", "ACTIVE"] },
  })
    .select("_id raw.provider_id raw.item_id")
    .lean();
  const banks = new Set(
    accounts.map((a) => String(a.raw?.provider_id || a.raw?.item_id || a._id)),
  );
  return banks.size;
}

/**
 * Refuse une nouvelle connexion bancaire au-delà du nombre de banques que
 * l'offre autorise (le site grise « Connecter une banque », l'API et
 * l'application mobile doivent aussi s'y tenir).
 */
export async function assertBankConnectionCapacity(workspaceId) {
  const { plan, limits } = await getWorkspacePlanLimits(workspaceId);
  const max = limits.bankAccounts;
  if (typeof max !== "number" || max < 0) return;
  const count = await countConnectedBanks(workspaceId);
  if (count >= max) {
    const allowed =
      max === 1
        ? "Votre offre n'autorise qu'une banque connectée."
        : `Votre offre n'autorise pas plus de ${max} banques connectées.`;
    throw new AppError(
      `${allowed}${upgradeHint(plan, "en connecter davantage")}`,
      ERROR_CODES.FORBIDDEN,
    );
  }
}
