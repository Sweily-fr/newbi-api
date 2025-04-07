const nodemailer = require('nodemailer');

// Création du transporteur pour l'envoi d'emails avec Mailtrap
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const contactResolvers = {
  Mutation: {
    sendContactMessage: async (_, { input }) => {
      const { name, email, subject, message } = input;
      
      try {
        // Configuration du message
        const mailOptions = {
          from: process.env.FROM_EMAIL,
          to: 'contact@generation-business.com', // Adresse email de réception des messages de contact
          replyTo: email,
          subject: `Formulaire de contact: ${subject}`,
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Nouveau message de contact</title>
              <style>
                body {
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                  line-height: 1.6;
                  color: #333;
                  margin: 0;
                  padding: 0;
                  background-color: #f9fafb;
                }
                .container {
                  max-width: 600px;
                  margin: 0 auto;
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
                  padding: 20px 0;
                }
                .field {
                  margin-bottom: 15px;
                }
                .field-label {
                  font-weight: bold;
                  color: #4b5563;
                }
                .field-value {
                  margin-top: 5px;
                }
                .footer {
                  text-align: center;
                  padding: 20px 0;
                  color: #6b7280;
                  font-size: 14px;
                  border-top: 1px solid #e5e7eb;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div style="text-align: center; margin-bottom: 20px;">
                    <img src="${process.env.FRONTEND_URL}/images/logo_gb/PNG/Logo+texte_black.png" alt="Generation Business" style="width: 200px; height: auto;">
                  </div>
                  <h1 style="color: #3b82f6; margin: 0;">Nouveau message de contact</h1>
                </div>
                <div class="content">
                  <div class="field">
                    <div class="field-label">Nom:</div>
                    <div class="field-value">${name}</div>
                  </div>
                  <div class="field">
                    <div class="field-label">Email:</div>
                    <div class="field-value">${email}</div>
                  </div>
                  <div class="field">
                    <div class="field-label">Sujet:</div>
                    <div class="field-value">${subject}</div>
                  </div>
                  <div class="field">
                    <div class="field-label">Message:</div>
                    <div class="field-value">${message}</div>
                  </div>
                </div>
                <div class="footer">
                  <p>Ce message a été envoyé depuis le formulaire de contact du site Generation Business.</p>
                </div>
              </div>
            </body>
            </html>
          `
        };
        
        // Envoi de l'email
        await transporter.sendMail(mailOptions);
        
        // Envoi d'un email de confirmation à l'expéditeur
        const confirmationMailOptions = {
          from: process.env.FROM_EMAIL,
          to: email,
          subject: 'Confirmation de votre message - Generation Business',
          html: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Confirmation de votre message</title>
              <style>
                body {
                  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                  line-height: 1.6;
                  color: #333;
                  margin: 0;
                  padding: 0;
                  background-color: #f9fafb;
                }
                .container {
                  max-width: 600px;
                  margin: 0 auto;
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
                  padding: 20px 0;
                }
                .footer {
                  text-align: center;
                  padding: 20px 0;
                  color: #6b7280;
                  font-size: 14px;
                  border-top: 1px solid #e5e7eb;
                }
                .button {
                  display: inline-block;
                  background-color: #3b82f6;
                  color: white;
                  text-decoration: none;
                  padding: 10px 20px;
                  border-radius: 5px;
                  margin-top: 15px;
                }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <div style="text-align: center; margin-bottom: 20px;">
                    <img src="${process.env.FRONTEND_URL}/images/logo_gb/PNG/Logo+texte_black.png" alt="Generation Business" style="width: 200px; height: auto;">
                  </div>
                  <h1 style="color: #3b82f6; margin: 0;">Confirmation de réception</h1>
                </div>
                <div class="content">
                  <p>Bonjour ${name},</p>
                  <p>Nous avons bien reçu votre message concernant "${subject}".</p>
                  <p>Notre équipe va l'examiner et vous répondra dans les plus brefs délais.</p>
                  <p>Merci de nous avoir contactés !</p>
                  <div style="text-align: center; margin-top: 20px;">
                    <a href="${process.env.FRONTEND_URL}" class="button">Visiter notre site</a>
                  </div>
                </div>
                <div class="footer">
                  <p>© ${new Date().getFullYear()} Generation Business. Tous droits réservés.</p>
                </div>
              </div>
            </body>
            </html>
          `
        };
        
        await transporter.sendMail(confirmationMailOptions);
        
        return {
          success: true,
          message: 'Votre message a été envoyé avec succès. Nous vous répondrons dans les plus brefs délais.'
        };
      } catch (error) {
        console.error('Erreur lors de l\'envoi du message de contact:', error);
        return {
          success: false,
          message: 'Une erreur est survenue lors de l\'envoi de votre message. Veuillez réessayer plus tard.'
        };
      }
    }
  }
};

module.exports = contactResolvers;
