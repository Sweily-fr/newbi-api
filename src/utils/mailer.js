import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

const sendPasswordResetEmail = async (email, resetToken) => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

  const mailOptions = {
    from: "Newbi <contact@newbi.fr>",
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: "Réinitialisation de votre mot de passe - Newbi",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Réinitialisation de mot de passe</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f0eeff;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #e5e7eb;
          }
          .logo {
            display: inline-block;
            margin-bottom: 20px;
          }
          .logo-text {
            font-size: 34px;
            font-weight: 800;
            color: #1f2937;
            letter-spacing: -0.025em;
          }
          .logo-dot {
            color: #3b82f6;
          }
          .logo-subtitle {
            font-size: 14px;
            color: #6b7280;
            margin-top: -5px;
          }
          .content {
            padding: 30px 20px;
          }
          h1 {
            color: #1f2937;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 20px;
          }
          p {
            margin-bottom: 16px;
            color: #4b5563;
          }
          .btn {
            display: inline-block;
            background-color: #5b50ff;
            color: white;
            font-weight: 600;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: center;
          }
          .btn:hover {
            background-color: #4a41e0;
          }
          .link-fallback {
            word-break: break-all;
            color: #6b7280;
            font-size: 14px;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #6b7280;
            font-size: 14px;
            border-top: 1px solid #e5e7eb;
          }
          .expiry {
            display: inline-block;
            background-color: #fee2e2;
            color: #b91c1c;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">
              <img src="${process.env.FRONTEND_URL}/images/logo_newbi/SVG/Logo_Texte_Purple.svg" alt="Newbi" style="width: 200px; height: auto;">
            </div>
          </div>
          
          <div class="content">
            <h1>Réinitialisation de votre mot de passe</h1>
            <p>Bonjour,</p>
            <p>Nous avons reçu une demande de réinitialisation de mot de passe pour votre compte Newbi.</p>
            <p>Cliquez sur le bouton ci-dessous pour définir un nouveau mot de passe :</p>
            
            <div style="text-align: center;">
              <a href="${resetLink}" class="btn">Réinitialiser mon mot de passe</a>
            </div>
            
            <div class="expiry">
              <strong>Important :</strong> Ce lien expirera dans 1 heure.
            </div>
            
            <p>Si le bouton ne fonctionne pas, vous pouvez copier et coller le lien suivant dans votre navigateur :</p>
            <p class="link-fallback">${resetLink}</p>
            
            <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email en toute sécurité.</p>
          </div>
          
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
            <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Error sending email:", error);
    return false;
  }
};

const sendVerificationEmail = async (email, verificationToken) => {
  const verificationLink = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;

  const mailOptions = {
    from: "Newbi <contact@newbi.fr>",
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: "Vérification de votre adresse email - Newbi",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Vérification d'adresse email</title>
        <style>
           body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f0eeff;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #e5e7eb;
          }
          .logo {
            display: inline-block;
            margin-bottom: 20px;
          }
          .logo-text {
            font-size: 34px;
            font-weight: 800;
            color: #1f2937;
            letter-spacing: -0.025em;
          }
          .logo-dot {
            color: #3b82f6;
          }
          .logo-subtitle {
            font-size: 14px;
            color: #6b7280;
            margin-top: -5px;
          }
          .content {
            padding: 30px 20px;
          }
          h1 {
            color: #1f2937;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 20px;
          }
          p {
            margin-bottom: 16px;
            color: #4b5563;
          }
          .btn {
            display: inline-block;
            background-color: #5b50ff;
            color: white;
            font-weight: 600;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: center;
          }
          .btn:hover {
            background-color: #4a41e0;
          }
          .link-fallback {
            word-break: break-all;
            color: #6b7280;
            font-size: 14px;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #6b7280;
            font-size: 14px;
            border-top: 1px solid #e5e7eb;
          }
          .expiry {
            display: inline-block;
            background-color: #fee2e2;
            color: #b91c1c;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            margin: 20px 0;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">
              <img src="${process.env.FRONTEND_URL}/images/logo_newbi/SVG/Logo_Texte_Purple.svg" alt="Newbi" style="width: 200px; height: auto;">
            </div>
          </div>
          <div class="content">
          <h1>Vérification de votre adresse email</h1>
            <p>Bonjour,</p>
            <p>Merci de vous être inscrit sur Newbi. Pour activer votre compte et accéder à toutes les fonctionnalités, veuillez vérifier votre adresse email en cliquant sur le bouton ci-dessous :</p>
            <p style="text-align: center;">
              <a href="${verificationLink}" class="btn">Vérifier mon adresse email</a>
            </p>
            <p>Si vous n'avez pas créé de compte sur Newbi, vous pouvez ignorer cet email.</p>
            <p>Si le bouton ne fonctionne pas, vous pouvez également copier et coller le lien suivant dans votre navigateur :</p>
            <p>${verificationLink}</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Erreur lors de l'envoi de l'email de vérification:", error);
    return false;
  }
};

const sendPasswordResetConfirmationEmail = async (email) => {
  const loginLink = `${process.env.FRONTEND_URL}/auth`;

  const mailOptions = {
    from: "Newbi <contact@newbi.fr>",
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: "Confirmation de réinitialisation de mot de passe - Newbi",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Confirmation de réinitialisation de mot de passe</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f0eeff;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #e5e7eb;
          }
          .logo {
            display: inline-block;
            margin-bottom: 20px;
          }
          .logo-text {
            font-size: 34px;
            font-weight: 800;
            color: #1f2937;
            letter-spacing: -0.025em;
          }
          .logo-dot {
            color: #3b82f6;
          }
          .logo-subtitle {
            font-size: 14px;
            color: #6b7280;
            margin-top: -5px;
          }
          .content {
            padding: 30px 20px;
          }
          h1 {
            color: #1f2937;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 20px;
          }
          p {
            margin-bottom: 16px;
            color: #4b5563;
          }
          .btn {
            display: inline-block;
            background-color: #5b50ff;
            color: white;
            font-weight: 600;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: center;
          }
          .btn:hover {
            background-color: #4a41e0;
          }
          .link-fallback {
            word-break: break-all;
            color: #6b7280;
            font-size: 14px;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #6b7280;
            font-size: 14px;
            border-top: 1px solid #e5e7eb;
          }
          .security-notice {
            background-color: #e6e1ff;
            padding: 15px;
            border-radius: 6px;
            margin-top: 30px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">
              <img src="${process.env.FRONTEND_URL}/images/logo_newbi/SVG/Logo_Texte_Purple.svg" alt="Newbi" style="width: 200px; height: auto;">
            </div>
          </div>
          <div class="content">
            <h1>Mot de passe réinitialisé avec succès</h1>
            <p>Bonjour,</p>
            <p>Nous vous confirmons que votre mot de passe a été réinitialisé avec succès.</p>
            <p>Vous pouvez maintenant vous connecter à votre compte avec votre nouveau mot de passe.</p>
            <a href="${loginLink}" class="btn">Se connecter</a>
            <p>Si vous n'avez pas demandé cette réinitialisation de mot de passe, veuillez contacter immédiatement notre support à <a href="mailto:support@newbi.com">support@newbi.com</a>.</p>
            <div class="security-notice">
              <strong>Note de sécurité :</strong> Pour protéger votre compte, ne partagez jamais votre mot de passe avec qui que ce soit, y compris le personnel de Newbi. Nous ne vous demanderons jamais votre mot de passe par email ou par téléphone.
            </div>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
            <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    // Email de confirmation de réinitialisation de mot de passe envoyé à ${email}
  } catch (error) {
    console.error(
      "Erreur lors de l'envoi de l'email de confirmation de réinitialisation:",
      error
    );
    throw error;
  }
};

const sendFileTransferEmail = async (recipientEmail, transferData) => {
  const { shareLink, accessKey, senderName, message, files, expiryDate } = transferData;
  const transferUrl = `${process.env.FRONTEND_URL}/transfer/${shareLink}?accessKey=${accessKey}`;
  
  const filesList = files.map(file => 
    `<li style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">
      <strong>${file.originalName}</strong> 
      <span style="color: #6b7280; font-size: 14px;">(${formatFileSize(file.size)})</span>
    </li>`
  ).join('');

  const mailOptions = {
    from: "Newbi <contact@newbi.fr>",
    replyTo: process.env.FROM_EMAIL,
    to: recipientEmail,
    subject: `${senderName || 'Quelqu\'un'} vous a envoyé des fichiers via Newbi`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Transfert de fichiers - Newbi</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f0eeff;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #e5e7eb;
          }
          .content {
            padding: 30px 20px;
          }
          h1 {
            color: #1f2937;
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 20px;
          }
          p {
            margin-bottom: 16px;
            color: #4b5563;
          }
          .btn {
            display: inline-block;
            background-color: #5b50ff;
            color: white;
            font-weight: 600;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: center;
          }
          .btn:hover {
            background-color: #4a41e0;
          }
          .files-list {
            background-color: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 16px;
            margin: 20px 0;
          }
          .files-list ul {
            list-style: none;
            padding: 0;
            margin: 0;
          }
          .message-box {
            background-color: #e6e1ff;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
            font-style: italic;
          }
          .expiry {
            display: inline-block;
            background-color: #fee2e2;
            color: #b91c1c;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 14px;
            margin: 20px 0;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #6b7280;
            font-size: 14px;
            border-top: 1px solid #e5e7eb;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <img src="${process.env.FRONTEND_URL}/images/logo_newbi/SVG/Logo_Texte_Purple.svg" alt="Newbi" style="width: 200px; height: auto;">
          </div>
          
          <div class="content">
            <h1>📁 Vous avez reçu des fichiers</h1>
            <p>Bonjour,</p>
            <p><strong>${senderName || 'Quelqu\'un'}</strong> vous a envoyé ${files.length} fichier(s) via Newbi.</p>
            
            ${message ? `
              <div class="message-box">
                <strong>Message :</strong><br>
                ${message}
              </div>
            ` : ''}
            
            <div class="files-list">
              <h3 style="margin-top: 0; color: #374151;">Fichiers inclus :</h3>
              <ul>${filesList}</ul>
            </div>
            
            <div style="text-align: center;">
              <a href="${transferUrl}" class="btn">Télécharger les fichiers</a>
            </div>
            
            <div class="expiry">
              <strong>⏰ Attention :</strong> Ce transfert expire le ${new Date(expiryDate).toLocaleDateString('fr-FR', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}.
            </div>
            
            <p>Si le bouton ne fonctionne pas, vous pouvez copier et coller le lien suivant dans votre navigateur :</p>
            <p style="word-break: break-all; color: #6b7280; font-size: 14px;">${transferUrl}</p>
            
            <p><strong>Sécurisé et confidentiel :</strong> Vos fichiers sont stockés de manière sécurisée et seront automatiquement supprimés après expiration.</p>
          </div>
          
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
            <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Erreur lors de l'envoi de l'email de transfert:", error);
    return false;
  }
};

// Fonction utilitaire pour formater la taille des fichiers
const formatFileSize = (bytes) => {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const sendReferralThankYouEmail = async (referrer, referredUser, payoutAmount) => {
  const dashboardLink = `${process.env.FRONTEND_URL}/dashboard`;

  const mailOptions = {
    from: "Newbi <contact@newbi.fr>",
    replyTo: process.env.FROM_EMAIL,
    to: referrer.email,
    subject: "🎉 Félicitations ! Votre parrainage vous a rapporté 50€ - Newbi",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Parrainage réussi - Newbi</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f0eeff;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            padding: 20px;
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }
          .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 1px solid #e5e7eb;
          }
          .content {
            padding: 30px 20px;
          }
          h1 {
            color: #1f2937;
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 20px;
            text-align: center;
          }
          p {
            margin-bottom: 16px;
            color: #4b5563;
          }
          .btn {
            display: inline-block;
            background-color: #5b50ff;
            color: white;
            font-weight: 600;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            margin: 20px 0;
            text-align: center;
          }
          .btn:hover {
            background-color: #4a41e0;
          }
          .celebration-box {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            margin: 25px 0;
          }
          .celebration-box h2 {
            margin: 0 0 10px 0;
            font-size: 24px;
            font-weight: 800;
          }
          .celebration-box .amount {
            font-size: 36px;
            font-weight: 900;
            margin: 10px 0;
          }
          .referral-info {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
          }
          .referral-info h3 {
            margin-top: 0;
            color: #374151;
            font-size: 18px;
          }
          .referral-stats {
            display: flex;
            justify-content: space-between;
            background-color: #e6e1ff;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
          }
          .stat-item {
            text-align: center;
            flex: 1;
          }
          .stat-value {
            font-size: 20px;
            font-weight: 700;
            color: #5b50ff;
          }
          .stat-label {
            font-size: 12px;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          .footer {
            text-align: center;
            padding: 20px;
            color: #6b7280;
            font-size: 14px;
            border-top: 1px solid #e5e7eb;
          }
          .emoji {
            font-size: 24px;
            margin: 0 5px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <img src="${process.env.FRONTEND_URL}/images/logo_newbi/SVG/Logo_Texte_Purple.svg" alt="Newbi" style="width: 200px; height: auto;">
          </div>
          
          <div class="content">
            <h1>🎉 Parrainage réussi !</h1>
            
            <div class="celebration-box">
              <h2>Félicitations ${referrer.firstName || referrer.email} !</h2>
              <div class="amount">+${payoutAmount}€</div>
              <p style="margin: 0; font-size: 16px; opacity: 0.9;">
                viennent d'être versés sur votre compte Stripe Connect
              </p>
            </div>
            
            <p>Excellente nouvelle ! Votre filleul <strong>${referredUser.email}</strong> vient de souscrire à un abonnement annuel Newbi.</p>
            
            <div class="referral-info">
              <h3>📊 Détails du parrainage</h3>
              <p><strong>Filleul :</strong> ${referredUser.email}</p>
              <p><strong>Date de souscription :</strong> ${new Date().toLocaleDateString('fr-FR', { 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}</p>
              <p><strong>Récompense :</strong> ${payoutAmount}€</p>
              <p><strong>Statut :</strong> <span style="color: #f59e0b; font-weight: 600;">⏳ Programmé</span></p>
            </div>
            
            <div style="background-color: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: 15px; margin: 20px 0;">
              <h4 style="margin-top: 0; color: #92400e; font-size: 16px;">⏰ Délai de paiement</h4>
              <p style="margin-bottom: 0; color: #92400e;">
                Pour des raisons de sécurité financière, votre récompense de <strong>${payoutAmount}€</strong> sera versée sur votre compte Stripe Connect dans <strong>7 jours</strong>, soit le <strong>${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}</strong>.
              </p>
            </div>
            
            <p>🚀 <strong>Continuez à parrainer !</strong> Chaque nouveau filleul qui souscrit à un abonnement annuel vous rapporte ${payoutAmount}€. Il n'y a pas de limite au nombre de parrainages que vous pouvez effectuer.</p>
            
            <div style="text-align: center;">
              <a href="${dashboardLink}" class="btn">Voir mon tableau de bord</a>
            </div>
            
            <div class="referral-stats">
              <div class="stat-item">
                <div class="stat-value">⏰</div>
                <div class="stat-label">Paiement dans 7 jours</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">♾️</div>
                <div class="stat-label">Parrainages illimités</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">🎯</div>
                <div class="stat-label">50€ par filleul</div>
              </div>
            </div>
            
            <p style="font-size: 14px; color: #6b7280; text-align: center;">
              <strong>Comment ça marche ?</strong><br>
              Partagez votre lien de parrainage → Votre filleul s'inscrit → Il souscrit à un abonnement annuel → Vous recevez 50€ !
            </p>
            
            <p>Merci de faire confiance à Newbi et de nous aider à grandir ! <span class="emoji">🙏</span></p>
          </div>
          
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
            <p>Cet email a été envoyé automatiquement, merci de ne pas y répondre.</p>
            <p>Questions ? Contactez-nous à <a href="mailto:support@newbi.fr">support@newbi.fr</a></p>
          </div>
        </div>
      </body>
      </html>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Erreur lors de l'envoi de l'email de remerciement parrainage:", error);
    return false;
  }
};

export {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendPasswordResetConfirmationEmail,
  sendFileTransferEmail,
  sendReferralThankYouEmail
};
