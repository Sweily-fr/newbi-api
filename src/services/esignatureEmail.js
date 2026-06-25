import emailReminderService from "./emailReminderService.js";
import logger from "../utils/logger.js";

/**
 * Service d'envoi des emails d'invitation à signer un document.
 *
 * L'API eSignature OpenAPI renvoie une URL de signature par signataire mais
 * n'envoie pas toujours d'email (notamment en sandbox). On envoie donc nous-mêmes
 * l'invitation via Resend, sur le même gabarit que les autres emails Newbi, pour
 * que le parcours fonctionne en sandbox comme en production et reste maîtrisé.
 */

const NEWBI_LOGO_BLACK =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png";
const NEWBI_LOGO_PURPLE =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png";

/**
 * Gabarit HTML de l'email d'invitation à signer (logo centré, carte blanche,
 * badge violet, bouton noir, footer marque) — aligné sur documentEmailService.
 */
function buildSigningEmailHtml({
  signerName,
  companyName,
  documentNumber,
  totalAmount,
  signingUrl,
  qualified,
}) {
  const todayFormatted = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const detailRow = (label, value, opts = {}) => {
    if (value === null || value === undefined || value === "") return "";
    const weight = opts.strong ? "600" : "400";
    return `
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#6b7280;">${label}</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:${weight};word-break:break-word;">${value}</td>
                </tr>`;
  };

  const detailRows = `${detailRow("Numéro du devis", documentNumber)}${detailRow("Montant total", totalAmount, { strong: true })}${detailRow("Émetteur", companyName)}`;

  const levelNote = qualified
    ? "Cette signature est une signature électronique qualifiée (eIDAS) : vous authentifierez votre identité par code à usage unique."
    : "Vous authentifierez votre signature par un code à usage unique reçu par email ou SMS.";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signature du devis ${documentNumber}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#fafafa;color:#1a1a1a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#fafafa;font-size:1px;line-height:1px;">${companyName} vous invite à signer le devis ${documentNumber}.</div>
  <div style="max-width:600px;margin:0 auto;padding:0 20px;background-color:#fafafa;">

    <!-- Logo -->
    <div style="text-align:center;padding:40px 0 24px 0;">
      <img src="${NEWBI_LOGO_BLACK}" alt="Newbi" style="height:32px;width:auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align:center;margin-bottom:8px;">
      <span style="font-size:11px;font-weight:600;color:#1a1a1a;letter-spacing:0.5px;text-transform:uppercase;">DEMANDE DE SIGNATURE</span>
    </div>

    <!-- Date -->
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-size:12px;color:#6b7280;">${todayFormatted}</span>
    </div>

    <!-- Carte principale -->
    <div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 24px;margin-bottom:32px;">

      <!-- Badge -->
      <div style="margin-bottom:20px;">
        <div style="display:inline-block;background-color:#ede9fe;border-radius:6px;padding:8px 12px;">
          <span style="font-size:11px;font-weight:500;color:#5a50ff;letter-spacing:0.3px;text-transform:uppercase;">DEVIS À SIGNER</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size:26px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;line-height:1.3;">Signez votre devis</h1>

      <!-- Message -->
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">
        Bonjour ${signerName},<br><br>
        <strong style="color:#1a1a1a;">${companyName}</strong> vous invite à signer électroniquement le devis
        <strong style="color:#1a1a1a;">${documentNumber}</strong>. La signature vaut bon pour accord.
      </div>

      <!-- Note niveau de signature -->
      <div style="background-color:#fafafa;border-left:3px solid #5a50ff;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px;">
        <p style="font-size:14px;color:#4b5563;margin:0;line-height:1.6;">🔒 ${levelNote}</p>
      </div>

      <!-- Détails -->
      <div style="background-color:#fafafa;border-radius:8px;padding:16px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">${detailRows}
        </table>
      </div>

      <!-- Bouton CTA -->
      <a href="${signingUrl}" style="display:block;background-color:#1a1a1a;color:#ffffff;text-decoration:none;padding:16px 24px;border-radius:6px;font-weight:500;font-size:15px;text-align:center;">Signer le devis</a>
      <p style="font-size:12px;color:#9ca3af;margin:16px 0 0 0;text-align:center;line-height:1.6;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br><span style="color:#5a50ff;word-break:break-all;">${signingUrl}</span></p>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:32px;text-align:center;padding-bottom:40px;">
      <div style="margin-bottom:16px;">
        <img src="${NEWBI_LOGO_PURPLE}" alt="Newbi" style="height:28px;width:auto;">
      </div>
      <p style="font-size:13px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;">Votre gestion, simplifiée.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0 0 24px 0;line-height:1.8;">Cette demande de signature a été envoyée par ${companyName} depuis Newbi, logiciel de gestion.</p>
      <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
        <p style="margin:0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin:0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Envoie l'invitation à signer à chaque signataire disposant d'une URL de signature.
 *
 * @param {object} params
 * @param {Array<{email:string,name?:string,surname?:string,url:string}>} params.signerUrls
 *   Signataires avec leur URL individuelle (issue de la réponse de l'API).
 * @param {string} params.companyName - Nom de l'entreprise émettrice
 * @param {string} params.documentNumber - Numéro du devis (préfixe inclus si dispo)
 * @param {string|null} params.totalAmount - Montant total formaté (optionnel)
 * @param {boolean} params.qualified - true pour une signature qualifiée (QES_otp)
 * @returns {Promise<number>} Nombre d'emails envoyés
 */
export async function sendSignatureInvitations({
  signerUrls,
  companyName,
  documentNumber,
  totalAmount = null,
  qualified = false,
}) {
  const recipients = (signerUrls || []).filter((s) => s && s.email && s.url);
  if (recipients.length === 0) {
    logger.warn(
      "sendSignatureInvitations: aucune URL de signature exploitable, aucun email envoyé",
    );
    return 0;
  }

  const subject = `${companyName} vous invite à signer le devis ${documentNumber}`;
  let sent = 0;

  for (const signer of recipients) {
    const signerName = [signer.name, signer.surname]
      .filter(Boolean)
      .join(" ")
      .trim();
    try {
      const html = buildSigningEmailHtml({
        signerName: signerName || "",
        companyName,
        documentNumber,
        totalAmount,
        signingUrl: signer.url,
        qualified,
      });
      await emailReminderService.sendEmail({
        to: signer.email,
        subject,
        html,
      });
      sent += 1;
    } catch (err) {
      logger.error(
        `Échec envoi invitation signature à ${signer.email}: ${err.message}`,
      );
    }
  }

  logger.info(
    `Invitations de signature envoyées: ${sent}/${recipients.length} pour le devis ${documentNumber}`,
  );
  return sent;
}

export default { sendSignatureInvitations };
