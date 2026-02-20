import logger from "../utils/logger.js";

/**
 * Service de routage e-invoicing / e-reporting
 *
 * Détermine pour chaque facture si elle relève de :
 * - E_INVOICING : Facture B2B domestique France-France (actif)
 * - E_REPORTING_TRANSACTION : B2C, international, etc. (préparé, commenté)
 * - E_REPORTING_PAYMENT : TVA sur encaissements + paiement reçu (préparé, commenté)
 * - NONE : Pas soumise aux obligations
 */

// Mapping forme juridique → taille d'entreprise (heuristique)
const COMPANY_STATUS_TO_SIZE = {
  AUTO_ENTREPRENEUR: "TPE_MICRO",
  EI: "TPE_MICRO",
  EIRL: "TPE_MICRO",
  EURL: "TPE_MICRO",
  SASU: "TPE_MICRO",
  SARL: "PME",
  SAS: "PME",
  SNC: "PME",
  SCI: "PME",
  SCOP: "PME",
  ASSOCIATION: "PME",
  AUTRE: "PME",
  SA: "GE_ETI",
};

// Dates d'obligation e-invoicing (émission / e-reporting) par taille
const OBLIGATION_DATES = {
  GE_ETI: new Date("2026-09-01"),
  PME: new Date("2027-09-01"),
  TPE_MICRO: new Date("2027-09-01"),
};

// Codes ISO France + DOM-TOM
const FRANCE_CODES = new Set(["FR", "GP", "MQ", "GF", "RE", "YT"]);

// Mapping pays français → code ISO (réutilisé de superPdpService)
const COUNTRY_NAME_TO_CODE = {
  france: "FR",
  allemagne: "DE",
  belgique: "BE",
  espagne: "ES",
  italie: "IT",
  luxembourg: "LU",
  "pays-bas": "NL",
  portugal: "PT",
  "royaume-uni": "GB",
  suisse: "CH",
  autriche: "AT",
  irlande: "IE",
  grèce: "GR",
  pologne: "PL",
  "république tchèque": "CZ",
  roumanie: "RO",
  hongrie: "HU",
  bulgarie: "BG",
  croatie: "HR",
  danemark: "DK",
  finlande: "FI",
  suède: "SE",
  slovaquie: "SK",
  slovénie: "SI",
  estonie: "EE",
  lettonie: "LV",
  lituanie: "LT",
  malte: "MT",
  chypre: "CY",
  "états-unis": "US",
  canada: "CA",
  japon: "JP",
  chine: "CN",
  "royaume uni": "GB",
  guadeloupe: "GP",
  martinique: "MQ",
  "guyane française": "GF",
  guyane: "GF",
  réunion: "RE",
  "la réunion": "RE",
  mayotte: "YT",
};

class EInvoiceRoutingService {
  /**
   * Détermine le type de flux e-invoicing pour une facture
   * @param {Object} invoice - La facture (document Mongoose)
   * @param {Object} organization - L'organisation (document MongoDB)
   * @returns {{ flowType: string, reason: string, details: Object }}
   */
  determineFlowType(invoice, organization) {
    const details = {
      isB2B: false,
      sellerInFrance: false,
      clientInFrance: false,
      sellerVatRegistered: false,
      clientVatRegistered: false,
      obligationActive: false,
      companySize: null,
      evaluatedAt: new Date(),
    };

    // 1. E-invoicing activé ?
    if (!organization?.eInvoicingEnabled) {
      return {
        flowType: "NONE",
        reason: "E-invoicing non activé pour cette organisation",
        details,
      };
    }

    // 2. Déterminer la taille de l'entreprise
    const companyStatus = invoice.companyInfo?.companyStatus;
    const companySize = this.getCompanySizeFromStatus(companyStatus);
    details.companySize = companySize;

    // 3. Obligation active pour cette taille + date facture ?
    const invoiceDate = invoice.issueDate || invoice.createdAt || new Date();
    const obligationActive = this.isObligationActive(companySize, invoiceDate);
    details.obligationActive = obligationActive;

    if (!obligationActive) {
      return {
        flowType: "NONE",
        reason: `Obligation e-invoicing pas encore active pour les ${companySize} (date facture: ${invoiceDate.toISOString().split("T")[0]})`,
        details,
      };
    }

    // 4. Évaluer les critères
    const vatPaymentCondition =
      invoice.companyInfo?.vatPaymentCondition || "NONE";

    // B2B ?
    details.isB2B = this.isB2B(invoice);

    // Vendeur en France ?
    details.sellerInFrance = this.isSellerInFrance(invoice);

    // Client en France ?
    details.clientInFrance = this.isClientInFrance(invoice);

    // Vendeur assujetti TVA ?
    details.sellerVatRegistered = this.isSellerVatRegistered(invoice);

    // Client identifié TVA ?
    details.clientVatRegistered = this.isClientVatRegistered(invoice);

    // Cas EXONERATION : vendeur non assujetti → pas e-invoicing
    if (vatPaymentCondition === "EXONERATION") {
      // TODO E-REPORTING: Retournera E_REPORTING_TRANSACTION quand l'API sera disponible
      return {
        flowType: "NONE",
        reason:
          "Vendeur exonéré de TVA (micro-entrepreneur) — e-reporting futur",
        details,
      };
    }

    // 5. E-Invoicing : tous les critères doivent être vrais
    if (
      details.isB2B &&
      details.sellerInFrance &&
      details.clientInFrance &&
      details.sellerVatRegistered &&
      details.clientVatRegistered
    ) {
      return {
        flowType: "E_INVOICING",
        reason: "Facture B2B domestique France-France — e-invoicing obligatoire",
        details,
      };
    }

    // 6. Sinon → e-reporting transaction (commenté pour l'instant)
    // TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
    // const eReportingReason = this._buildEReportingReason(details);
    // return {
    //   flowType: 'E_REPORTING_TRANSACTION',
    //   reason: eReportingReason,
    //   details,
    // };

    // En attendant, retourner NONE pour les cas non-e-invoicing
    const reason = this._buildNonEInvoicingReason(details);
    return {
      flowType: "NONE",
      reason: `${reason} — e-reporting sera activé ultérieurement`,
      details,
    };
  }

  /**
   * Détermine la taille d'entreprise à partir de la forme juridique
   */
  getCompanySizeFromStatus(companyStatus) {
    if (!companyStatus) return "PME"; // Défaut prudent
    return COMPANY_STATUS_TO_SIZE[companyStatus] || "PME";
  }

  /**
   * Vérifie si l'obligation e-invoicing est active pour cette taille à cette date
   */
  isObligationActive(companySize, invoiceDate) {
    const obligationDate = OBLIGATION_DATES[companySize];
    if (!obligationDate) return false;

    const date =
      invoiceDate instanceof Date ? invoiceDate : new Date(invoiceDate);
    return date >= obligationDate;
  }

  /**
   * Vérifie si la facture est B2B (client = entreprise)
   */
  isB2B(invoice) {
    return invoice.client?.type === "COMPANY";
  }

  /**
   * Vérifie si le vendeur est en France
   */
  isSellerInFrance(invoice) {
    const country = invoice.companyInfo?.address?.country;
    const code = this.getCountryCode(country);
    return this.isFranceCode(code);
  }

  /**
   * Vérifie si le client est en France
   */
  isClientInFrance(invoice) {
    // Si isInternational est explicitement true → pas en France
    if (invoice.client?.isInternational === true) return false;

    // Vérifier aussi le pays si disponible
    const clientCountry = invoice.client?.address?.country;
    if (clientCountry) {
      const code = this.getCountryCode(clientCountry);
      return this.isFranceCode(code);
    }

    // Si pas de pays et pas marqué international → défaut France (SaaS français)
    return true;
  }

  /**
   * Vérifie si le vendeur est assujetti TVA
   */
  isSellerVatRegistered(invoice) {
    const companyInfo = invoice.companyInfo;
    if (!companyInfo) return false;

    // Exonération = non assujetti
    if (companyInfo.vatPaymentCondition === "EXONERATION") return false;

    // A un numéro de TVA ou un SIRET → assujetti
    const hasVat = !!(companyInfo.vatNumber && companyInfo.vatNumber.trim());
    const hasSiret = !!(companyInfo.siret && companyInfo.siret.trim());

    return hasVat || hasSiret;
  }

  /**
   * Vérifie si le client est identifié TVA (a un SIRET ou numéro de TVA)
   */
  isClientVatRegistered(invoice) {
    const client = invoice.client;
    if (!client) return false;

    const hasVat = !!(client.vatNumber && client.vatNumber.trim());
    const hasSiret = !!(client.siret && client.siret.trim());

    return hasVat || hasSiret;
  }

  /**
   * Convertit un nom de pays en code ISO 2 lettres
   */
  getCountryCode(country) {
    if (!country) return "FR"; // Défaut France pour un SaaS français

    const normalized = country.toLowerCase().trim();

    // Si c'est déjà un code ISO 2 lettres
    if (normalized.length === 2) {
      return normalized.toUpperCase();
    }

    return COUNTRY_NAME_TO_CODE[normalized] || "FR";
  }

  /**
   * Vérifie si un code pays correspond à la France (métropole + DOM-TOM)
   */
  isFranceCode(code) {
    return FRANCE_CODES.has(code);
  }

  /**
   * Construit la raison pour laquelle la facture n'est pas éligible au e-invoicing
   */
  _buildNonEInvoicingReason(details) {
    const reasons = [];
    if (!details.isB2B) reasons.push("client particulier (B2C)");
    if (!details.sellerInFrance) reasons.push("vendeur hors France");
    if (!details.clientInFrance) reasons.push("client hors France");
    if (!details.sellerVatRegistered) reasons.push("vendeur non assujetti TVA");
    if (!details.clientVatRegistered)
      reasons.push("client sans identification TVA");
    return reasons.length > 0
      ? `Non éligible e-invoicing : ${reasons.join(", ")}`
      : "Non éligible e-invoicing";
  }

  // TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
  // _buildEReportingReason(details) {
  //   const reasons = [];
  //   if (!details.isB2B) reasons.push('client particulier (B2C)');
  //   if (!details.clientInFrance) reasons.push('client international');
  //   if (!details.clientVatRegistered) reasons.push('client sans identification TVA');
  //   return reasons.length > 0
  //     ? `E-reporting obligatoire : ${reasons.join(', ')}`
  //     : 'E-reporting obligatoire';
  // }
}

// Singleton
const eInvoiceRoutingService = new EInvoiceRoutingService();
export default eInvoiceRoutingService;
