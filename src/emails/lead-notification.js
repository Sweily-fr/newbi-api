/**
 * Template email de notification pour un nouveau lead.
 * Meme design que les templates Next.js (style Qonto)
 */
export function buildLeadNotificationHtml({
  firstName = "Jean",
  lastName = "Dupont",
  companyName = "Ma Societe",
  email = "jean@entreprise.fr",
  phone = "06 12 34 56 78",
  source = "Non renseigné",
  guideName = "Guide Facturation Electronique",
} = {}) {
  const date = new Date()
    .toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nouveau lead - ${firstName} ${lastName}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <div style="max-width: 600px; margin: 0 auto; padding: 0 20px; background-color: #fafafa;">

    <!-- Logo -->
    <div style="text-align: center; padding: 40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height: 32px; width: auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align: center; margin-bottom: 8px;">
      <span style="font-size: 11px; font-weight: 600; color: #1a1a1a; letter-spacing: 0.5px; text-transform: uppercase;">
        NOUVEAU LEAD
      </span>
    </div>

    <!-- Date -->
    <div style="text-align: center; margin-bottom: 32px;">
      <span style="font-size: 12px; color: #6b7280;">${date}</span>
    </div>

    <!-- Carte principale -->
    <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 24px; margin-bottom: 32px;">

      <!-- Icone -->
      <div style="margin-bottom: 20px;">
        <div style="display: inline-flex; align-items: center; background-color: #f3f4f6; border-radius: 6px; padding: 8px 12px;">
          <span style="font-size: 11px; font-weight: 500; color: #374151; letter-spacing: 0.3px; text-transform: uppercase;">FORMULAIRE GUIDE</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size: 26px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0; line-height: 1.3;">
        Nouveau prospect enregistre
      </h1>

      <!-- Message -->
      <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
        Un nouveau prospect a telecharge le <strong>${guideName}</strong> depuis le site et a ete ajoute au CRM.
      </p>

      <!-- Tableau d'infos -->
      <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0; border-bottom: 1px solid #e5e7eb;">Prenom</td>
            <td style="font-size: 13px; color: #1a1a1a; padding: 10px 0; text-align: right; font-weight: 500; border-bottom: 1px solid #e5e7eb;">${firstName}</td>
          </tr>
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0; border-bottom: 1px solid #e5e7eb;">Nom</td>
            <td style="font-size: 13px; color: #1a1a1a; padding: 10px 0; text-align: right; font-weight: 500; border-bottom: 1px solid #e5e7eb;">${lastName}</td>
          </tr>
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0; border-bottom: 1px solid #e5e7eb;">Entreprise</td>
            <td style="font-size: 13px; color: #1a1a1a; padding: 10px 0; text-align: right; font-weight: 600; border-bottom: 1px solid #e5e7eb;">${companyName}</td>
          </tr>
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0; border-bottom: 1px solid #e5e7eb;">Email</td>
            <td style="font-size: 13px; padding: 10px 0; text-align: right; font-weight: 500; border-bottom: 1px solid #e5e7eb;"><a href="mailto:${email}" style="color: #5B4FFF; text-decoration: none;">${email}</a></td>
          </tr>
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0; border-bottom: 1px solid #e5e7eb;">Telephone</td>
            <td style="font-size: 13px; color: #1a1a1a; padding: 10px 0; text-align: right; font-weight: 500; border-bottom: 1px solid #e5e7eb;">${phone}</td>
          </tr>
          <tr>
            <td style="font-size: 13px; color: #6b7280; padding: 10px 0;">Source</td>
            <td style="font-size: 13px; color: #1a1a1a; padding: 10px 0; text-align: right; font-weight: 500;">${source}</td>
          </tr>
        </table>
      </div>

      <!-- CTA -->
      <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/clients" style="display: block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 16px 24px; border-radius: 6px; font-weight: 500; font-size: 15px; text-align: center;">
        Voir dans le CRM
      </a>
    </div>

    <!-- Footer -->
    <div style="border-top: 1px solid #e5e7eb; padding-top: 32px; text-align: center;">
      <div style="margin-bottom: 16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height: 28px; width: auto;">
      </div>
      <p style="font-size: 13px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0;">
        Votre gestion, simplifiee.
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin: 0 0 24px 0; line-height: 1.8;">
        Notification automatique. Ne repondez pas directement a cet email.
      </p>
      <div style="font-size: 11px; color: #9ca3af; line-height: 1.6;">
        <p style="margin: 0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin: 0;">229 rue Saint-Honore, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>`;
}
