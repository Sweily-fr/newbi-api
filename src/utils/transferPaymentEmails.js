/**
 * E-mails des transferts payants : au vendeur quand le destinataire a payé
 * ou annonce un virement, au payeur quand ses fichiers sont débloqués.
 * Mise en page commune des e-mails Newbi (renderEmail : pas d'icône, aucun
 * mot ni signe de ponctuation seul en bout de ligne).
 */
import { escapeHtml, renderEmail } from "./trialEmails.js";

const paragraph = (html, margin = "0 0 16px 0") =>
  `<p style="font-size: 15px; color: #4b5563; margin: ${margin}; line-height: 1.6;">${html}</p>`;

const PROVIDER_LABELS = {
  stripe: "Carte bancaire (Stripe)",
  sumup: "Carte bancaire (SumUp)",
  paypal: "PayPal",
  bank_transfer: "Virement bancaire",
};

const transferLabel = (transferTitle) =>
  transferTitle
    ? `le transfert « ${transferTitle} »`
    : "votre transfert de fichiers";

const filesLabel = (fileCount) =>
  `${fileCount} fichier${fileCount > 1 ? "s" : ""}`;

function detailRows(rows) {
  const cells = rows
    .map(
      ([label, value]) => `
          <tr>
            <td style="padding: 10px 0; font-size: 14px; color: #6b7280; border-bottom: 1px solid #f3f4f6;">${escapeHtml(label)}</td>
            <td style="padding: 10px 0; font-size: 14px; color: #1a1a1a; font-weight: 500; text-align: right; border-bottom: 1px solid #f3f4f6;">${escapeHtml(value)}</td>
          </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; margin: 0 0 24px 0;">${cells}
        </table>`;
}

export function buildTransferPaidEmail({
  amount,
  transferTitle,
  payerEmail,
  provider,
  fileCount = 0,
  url,
}) {
  const what = transferLabel(transferTitle);
  const files = filesLabel(fileCount);
  const rows = [
    ["Montant", amount],
    payerEmail ? ["Payé par", payerEmail] : null,
    PROVIDER_LABELS[provider]
      ? ["Moyen de paiement", PROVIDER_LABELS[provider]]
      : null,
    ["Fichiers", files],
  ].filter(Boolean);

  // Virement repéré sur le compte bancaire connecté du vendeur
  const bankTransfer = provider === "bank_transfer";
  const intro = bankTransfer
    ? `Le virement de ${amount} pour ${what} est arrivé sur votre compte.`
    : `Votre client a payé ${amount} pour ${what}.`;
  const introHtml = bankTransfer
    ? `Le virement de <strong style="color: #1a1a1a;">${escapeHtml(amount)}</strong> pour ${escapeHtml(what)} est arrivé sur votre compte.`
    : `Votre client a payé <strong style="color: #1a1a1a;">${escapeHtml(amount)}</strong> pour ${escapeHtml(what)}.`;

  return {
    subject: `Paiement reçu : ${amount}`,
    text: [
      intro,
      "Les fichiers sont maintenant disponibles au téléchargement.",
      payerEmail ? `Payé par : ${payerEmail}` : null,
      "L'argent a été versé directement sur votre compte, sans commission Newbi.",
      `Voir mes transferts : ${url}`,
    ]
      .filter(Boolean)
      .join("\n"),
    html: renderEmail({
      preheader: intro,
      badge: "PAIEMENT REÇU",
      title: "Votre transfert a été payé",
      bodyHtml: `
        ${paragraph(`${introHtml} Les fichiers sont maintenant disponibles au téléchargement.`, "0 0 24px 0")}
        ${detailRows(rows)}
        ${paragraph("L'argent a été versé directement sur votre compte, sans commission Newbi.", "0 0 24px 0")}
      `,
      ctaLabel: "Voir mes transferts",
      ctaUrl: url,
    }),
  };
}

/** Au vendeur : son client indique avoir payé par virement. */
export function buildTransferBankDeclaredEmail({
  amount,
  transferTitle,
  payerEmail,
  reference,
  autoDetect = false,
  url,
}) {
  const what = transferLabel(transferTitle);
  const who = payerEmail || "Votre client";
  const next = autoDetect
    ? "Votre compte bancaire est connecté à Newbi : le transfert se débloquera tout seul dès que le virement y arrivera, et votre client recevra le lien par e-mail."
    : "Dès que vous le voyez sur votre compte, débloquez le transfert avec « Marquer comme payé » : votre client recevra le lien par e-mail.";
  const rows = [
    ["Montant", amount],
    reference ? ["Référence du virement", reference] : null,
    payerEmail ? ["Annoncé par", payerEmail] : null,
  ].filter(Boolean);

  return {
    subject: `Virement annoncé : ${amount}`,
    text: [
      `${who} indique avoir fait un virement de ${amount} pour ${what}.`,
      reference ? `Référence du virement : ${reference}` : null,
      next,
      `Voir mes transferts : ${url}`,
    ]
      .filter(Boolean)
      .join("\n"),
    html: renderEmail({
      preheader: `${who} indique avoir fait un virement de ${amount}.`,
      badge: "VIREMENT ANNONCÉ",
      title: "Votre client a fait un virement",
      bodyHtml: `
        ${paragraph(`${escapeHtml(who)} indique avoir fait un virement de <strong style="color: #1a1a1a;">${escapeHtml(amount)}</strong> pour ${escapeHtml(what)}.`, "0 0 24px 0")}
        ${detailRows(rows)}
        ${paragraph(escapeHtml(next), "0 0 24px 0")}
      `,
      ctaLabel: autoDetect ? "Voir mes transferts" : "Vérifier et débloquer",
      ctaUrl: url,
    }),
  };
}

const formatDate = (date) => {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Europe/Paris",
    }).format(new Date(date));
  } catch {
    return null;
  }
};

/** Au payeur : le transfert est débloqué, voici le lien. */
export function buildTransferFilesAvailableEmail({
  sellerName,
  amount,
  transferTitle,
  fileCount = 0,
  expiryDate,
  url,
}) {
  const seller = sellerName || "L'expéditeur";
  const single = fileCount === 1;
  const named = transferTitle ? ` « ${transferTitle} »` : "";
  // « Vos fichiers « Photos » sont disponibles », « Votre fichier est disponible »
  const available = single
    ? `Votre fichier${named} est disponible au téléchargement.`
    : `Vos fichiers${named} sont disponibles au téléchargement.`;
  const until = expiryDate ? formatDate(expiryDate) : null;
  const intro = `${seller} a bien reçu votre paiement de ${amount}. ${available}`;
  const introHtml = `${escapeHtml(seller)} a bien reçu votre paiement de <strong style="color: #1a1a1a;">${escapeHtml(amount)}</strong>. ${escapeHtml(available)}`;
  const deadline = until ? `Le lien est valable jusqu'au ${until}.` : null;

  return {
    subject: "Vos fichiers sont disponibles",
    text: [intro, deadline, `Télécharger les fichiers : ${url}`]
      .filter(Boolean)
      .join("\n"),
    html: renderEmail({
      preheader: intro,
      badge: "FICHIERS DISPONIBLES",
      title: "Vos fichiers sont prêts",
      bodyHtml: `
        ${paragraph(introHtml, deadline ? "0 0 16px 0" : "0 0 24px 0")}
        ${deadline ? paragraph(escapeHtml(deadline), "0 0 24px 0") : ""}
      `,
      ctaLabel: "Télécharger les fichiers",
      ctaUrl: url,
    }),
  };
}
