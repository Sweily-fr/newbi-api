import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export const InvoiceReminderEmail = ({
  invoiceNumber = 'F-112024-0001',
  clientName = 'Client',
  totalAmount = '0,00 €',
  dueDate = '01/01/2024',
  companyName = 'Votre Entreprise',
  companyLogo = null,
  emailBody = '',
  reminderType = 'FIRST', // FIRST ou SECOND
}) => {
  const previewText = reminderType === 'FIRST' 
    ? `Rappel de paiement - Facture ${invoiceNumber}`
    : `2ème rappel de paiement - Facture ${invoiceNumber}`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header avec logo */}
          <Section style={header}>
            {companyLogo ? (
              <Img
                src={companyLogo}
                width="120"
                height="40"
                alt={companyName}
                style={logo}
              />
            ) : (
              <Text style={companyNameText}>{companyName}</Text>
            )}
          </Section>

          {/* Badge de type de relance */}
          <Section style={badgeSection}>
            <div style={reminderType === 'FIRST' ? badgeFirst : badgeSecond}>
              {reminderType === 'FIRST' ? '1ère relance' : '2ème relance'}
            </div>
          </Section>

          {/* Contenu principal */}
          <Section style={content}>
            <Heading style={h1}>
              {reminderType === 'FIRST' ? 'Rappel de paiement' : 'Dernier rappel de paiement'}
            </Heading>
            
            {/* Corps de l'email personnalisé */}
            <div style={emailBodyContainer}>
              {emailBody.split('\n').map((line, index) => (
                <Text key={index} style={text}>
                  {line || '\u00A0'}
                </Text>
              ))}
            </div>

            <Hr style={hr} />

            {/* Détails de la facture */}
            <Section style={detailsBox}>
              <Text style={detailsTitle}>Détails de la facture</Text>
              <table style={detailsTable}>
                <tr>
                  <td style={detailsLabel}>Numéro de facture</td>
                  <td style={detailsValue}>{invoiceNumber}</td>
                </tr>
                <tr>
                  <td style={detailsLabel}>Montant total</td>
                  <td style={detailsValue}><strong>{totalAmount}</strong></td>
                </tr>
                <tr>
                  <td style={detailsLabel}>Date d'échéance</td>
                  <td style={detailsValue}>{dueDate}</td>
                </tr>
              </table>
            </Section>

            {/* Note importante pour la 2ème relance */}
            {reminderType === 'SECOND' && (
              <Section style={warningBox}>
                <Text style={warningText}>
                  ⚠️ Il s'agit de notre dernier rappel concernant cette facture. 
                  Nous vous remercions de bien vouloir régulariser votre situation dans les plus brefs délais.
                </Text>
              </Section>
            )}

            <Text style={text}>
              La facture est jointe à cet email au format PDF.
            </Text>

            <Text style={text}>
              Pour toute question, n'hésitez pas à nous contacter.
            </Text>

            <Text style={regards}>
              Cordialement,<br />
              L'équipe {companyName}
            </Text>
          </Section>

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>
              Cet email a été envoyé automatiquement par le système de relance de {companyName}.
            </Text>
            <Text style={footerText}>
              Merci de ne pas répondre directement à cet email.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
};

// Styles
const main = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif',
};

const container = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '600px',
};

const header = {
  padding: '32px 48px',
  borderBottom: '1px solid #e6ebf1',
};

const logo = {
  margin: '0 auto',
};

const companyNameText = {
  fontSize: '24px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  margin: '0',
  textAlign: 'center',
};

const badgeSection = {
  textAlign: 'center',
  padding: '16px 0',
};

const badgeFirst = {
  display: 'inline-block',
  padding: '8px 16px',
  backgroundColor: '#3b82f6',
  color: '#ffffff',
  borderRadius: '20px',
  fontSize: '12px',
  fontWeight: 'bold',
  textTransform: 'uppercase',
};

const badgeSecond = {
  display: 'inline-block',
  padding: '8px 16px',
  backgroundColor: '#ef4444',
  color: '#ffffff',
  borderRadius: '20px',
  fontSize: '12px',
  fontWeight: 'bold',
  textTransform: 'uppercase',
};

const content = {
  padding: '0 48px',
};

const h1 = {
  color: '#1a1a1a',
  fontSize: '24px',
  fontWeight: 'bold',
  margin: '24px 0',
  padding: '0',
  textAlign: 'center',
};

const emailBodyContainer = {
  margin: '24px 0',
};

const text = {
  color: '#525f7f',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '8px 0',
};

const hr = {
  borderColor: '#e6ebf1',
  margin: '32px 0',
};

const detailsBox = {
  backgroundColor: '#f6f9fc',
  borderRadius: '8px',
  padding: '24px',
  margin: '24px 0',
};

const detailsTitle = {
  fontSize: '14px',
  fontWeight: 'bold',
  color: '#1a1a1a',
  margin: '0 0 16px 0',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const detailsTable = {
  width: '100%',
  borderCollapse: 'collapse',
};

const detailsLabel = {
  color: '#6b7280',
  fontSize: '14px',
  padding: '8px 0',
  width: '50%',
};

const detailsValue = {
  color: '#1a1a1a',
  fontSize: '14px',
  padding: '8px 0',
  textAlign: 'right',
  fontWeight: '500',
};

const warningBox = {
  backgroundColor: '#fef3c7',
  border: '1px solid #fbbf24',
  borderRadius: '8px',
  padding: '16px',
  margin: '24px 0',
};

const warningText = {
  color: '#92400e',
  fontSize: '14px',
  lineHeight: '20px',
  margin: '0',
};

const regards = {
  color: '#525f7f',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '32px 0 0 0',
};

const footer = {
  padding: '24px 48px',
  borderTop: '1px solid #e6ebf1',
  marginTop: '32px',
};

const footerText = {
  color: '#8898aa',
  fontSize: '12px',
  lineHeight: '16px',
  margin: '4px 0',
  textAlign: 'center',
};

export default InvoiceReminderEmail;
