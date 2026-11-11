/**
 * Types de fichiers comptés dans le stockage d'un espace (module léger, sans
 * accès à R2 : importable partout).
 */
// Version du calcul : l'augmenter force un recalcul de tous les espaces
export const STORAGE_COMPUTE_VERSION = 1;

export const STORAGE_CATEGORIES = {
  billingDocuments: "Documents de facturation",
  sharedDocuments: "Documents partagés",
  kanban: "Projets (pièces jointes et images)",
  receipts: "Justificatifs de transaction",
  purchaseInvoices: "Factures d'achat et documents scannés",
  importedDocuments: "Documents importés",
  branding: "Logos, images et signatures de mail",
  transfers: "Transferts de fichiers",
  social: "Réseaux sociaux",
  other: "Autres fichiers",
};

export const UNATTRIBUTED = "unattributed";
