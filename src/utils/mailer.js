const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendPasswordResetEmail = async (email, resetToken) => {
  const resetLink = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

  const mailOptions = {
    from: 'Newbi <contact@newbi.fr>',
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: 'Réinitialisation de votre mot de passe - Newbi',
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
    console.error('Error sending email:', error);
    return false;
  }
};

const sendVerificationEmail = async (email, verificationToken) => {
  const verificationLink = `${process.env.FRONTEND_URL}/verify-email/${verificationToken}`;

  const mailOptions = {
    from: 'Newbi <contact@newbi.fr>',
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: 'Vérification de votre adresse email - Newbi',
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
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'envoi de l\'email de vérification:', error);
    return false;
  }
};

const sendPasswordResetConfirmationEmail = async (email) => {
  const loginLink = `${process.env.FRONTEND_URL}/auth`;

  const mailOptions = {
    from: 'Newbi <contact@newbi.fr>',
    replyTo: process.env.FROM_EMAIL,
    to: email,
    subject: 'Confirmation de réinitialisation de mot de passe - Newbi',
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
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    // Email de confirmation de réinitialisation de mot de passe envoyé à ${email}
  } catch (error) {
    console.error('Erreur lors de l\'envoi de l\'email de confirmation de réinitialisation:', error);
    throw error;
  }
};

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendPasswordResetConfirmationEmail
};
