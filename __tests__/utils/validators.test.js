import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  isValidPhone,
  isValidPhoneFR,
  isValidName,
  isValidSIRET,
  isValidVATNumberFR,
  isValidVATNumberEU,
  isValidIBAN,
  isValidBIC,
  isValidPostalCodeFR,
  isValidStreet,
  isValidCity,
  isValidCountry,
  isValidURL,
  isStrongPassword,
  isPositiveAmount,
  isPositiveNonZeroAmount,
  isValidCreditAmount,
  isValidCreditNonZeroAmount,
  isPastDate,
  isFutureDate,
  isDateAfter,
  isValidPercentage,
  isNonEmptyTrimmedString,
  isWithinMaxLength,
  isWithinMinLength,
  isValidUnit,
  isValidFooterNotes,
  isValidCapitalSocial,
  isValidRCS,
  isFieldRequiredForCompanyStatus,
  REQUIRED_FIELDS_BY_COMPANY_STATUS,
} from '../../src/utils/validators.js';

describe('Email validation', () => {
  it('should accept valid emails', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
    expect(isValidEmail('user@sub.domain.com')).toBe(true);
  });

  it('should reject invalid emails', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user@.com')).toBe(false);
  });
});

describe('Phone validation', () => {
  it('should accept valid phone numbers (international)', () => {
    expect(isValidPhone('+33123456789')).toBe(true);
    expect(isValidPhone('0612345678')).toBe(true);
    expect(isValidPhone('+1 2125551234')).toBe(true);
  });

  it('should reject invalid phone numbers', () => {
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('abc')).toBe(false);
  });
});

describe('French phone validation', () => {
  it('should accept valid French phone numbers', () => {
    expect(isValidPhoneFR('0612345678')).toBe(true);
    expect(isValidPhoneFR('06 12 34 56 78')).toBe(true);
    expect(isValidPhoneFR('+33612345678')).toBe(true);
    expect(isValidPhoneFR('06-12-34-56-78')).toBe(true);
    expect(isValidPhoneFR('06.12.34.56.78')).toBe(true);
  });

  it('should reject invalid French phone numbers', () => {
    expect(isValidPhoneFR('1234')).toBe(false);
    expect(isValidPhoneFR('00000000000000')).toBe(false);
  });
});

describe('Name validation', () => {
  it('should accept valid names', () => {
    expect(isValidName('Jean')).toBe(true);
    expect(isValidName('Jean-Pierre')).toBe(true);
    expect(isValidName("D'Artagnan")).toBe(true);
    expect(isValidName('Product / Service 2.0')).toBe(true);
  });

  it('should reject names with XSS characters', () => {
    expect(isValidName('<script>alert(1)</script>')).toBe(false);
    expect(isValidName('Name<br>')).toBe(false);
  });

  it('should reject too short names', () => {
    expect(isValidName('A')).toBe(false);
  });
});

describe('SIRET/SIREN validation', () => {
  it('should accept valid SIREN (9 digits)', () => {
    expect(isValidSIRET('123456789')).toBe(true);
  });

  it('should accept valid SIRET (14 digits)', () => {
    expect(isValidSIRET('12345678901234')).toBe(true);
  });

  it('should reject invalid SIRET', () => {
    expect(isValidSIRET('12345')).toBe(false);
    expect(isValidSIRET('1234567890')).toBe(false);
    expect(isValidSIRET('abc')).toBe(false);
    expect(isValidSIRET('')).toBe(false);
  });
});

describe('VAT number validation', () => {
  it('should accept valid French VAT numbers', () => {
    expect(isValidVATNumberFR('FR12345678901')).toBe(true);
  });

  it('should reject invalid French VAT numbers', () => {
    expect(isValidVATNumberFR('FR1234')).toBe(false);
    expect(isValidVATNumberFR('DE123456789')).toBe(false);
  });

  it('should accept valid EU VAT numbers', () => {
    expect(isValidVATNumberEU('DE123456789')).toBe(true);
    expect(isValidVATNumberEU('GB123456789')).toBe(true);
  });

  it('should reject invalid EU VAT numbers', () => {
    expect(isValidVATNumberEU('1234')).toBe(false);
    expect(isValidVATNumberEU('XX')).toBe(false);
  });
});

describe('IBAN validation', () => {
  it('should accept valid French IBAN', () => {
    expect(isValidIBAN('FR7630006000011234567890189')).toBe(true);
  });

  it('should reject invalid IBAN', () => {
    expect(isValidIBAN('FR123')).toBe(false);
    expect(isValidIBAN('DE1234567890')).toBe(false);
    expect(isValidIBAN('')).toBe(false);
  });
});

describe('BIC validation', () => {
  it('should accept valid BIC codes', () => {
    expect(isValidBIC('BNPAFRPP')).toBe(true);
    expect(isValidBIC('BNPAFRPPXXX')).toBe(true);
  });

  it('should reject invalid BIC codes', () => {
    expect(isValidBIC('BNP')).toBe(false);
    expect(isValidBIC('123456')).toBe(false);
  });
});

describe('French postal code validation', () => {
  it('should accept valid postal codes', () => {
    expect(isValidPostalCodeFR('75001')).toBe(true);
    expect(isValidPostalCodeFR('13001')).toBe(true);
    expect(isValidPostalCodeFR('97400')).toBe(true);
  });

  it('should reject invalid postal codes', () => {
    expect(isValidPostalCodeFR('00000')).toBe(false);
    expect(isValidPostalCodeFR('99000')).toBe(false);
    expect(isValidPostalCodeFR('1234')).toBe(false);
  });
});

describe('URL validation', () => {
  it('should accept valid URLs', () => {
    expect(isValidURL('https://example.com')).toBe(true);
    expect(isValidURL('http://sub.domain.com/path')).toBe(true);
    expect(isValidURL('example.com')).toBe(true);
  });

  it('should reject invalid URLs', () => {
    expect(isValidURL('')).toBe(false);
    expect(isValidURL('not a url')).toBe(false);
  });
});

describe('Strong password validation', () => {
  it('should accept strong passwords', () => {
    expect(isStrongPassword('MyP@ssw0rd!')).toBe(true);
    expect(isStrongPassword('Str0ng&Pass')).toBe(true);
  });

  it('should reject weak passwords', () => {
    expect(isStrongPassword('short')).toBe(false);
    expect(isStrongPassword('alllowercase1!')).toBe(false);
    expect(isStrongPassword('ALLUPPERCASE1!')).toBe(false);
    expect(isStrongPassword('NoDigits!here')).toBe(false);
    expect(isStrongPassword('NoSpecial1here')).toBe(false);
  });
});

describe('Amount validations', () => {
  it('isPositiveAmount should accept zero and positive numbers', () => {
    expect(isPositiveAmount(0)).toBe(true);
    expect(isPositiveAmount(100)).toBe(true);
    expect(isPositiveAmount(-1)).toBe(false);
    expect(isPositiveAmount('abc')).toBe(false);
  });

  it('isPositiveNonZeroAmount should reject zero', () => {
    expect(isPositiveNonZeroAmount(0)).toBe(false);
    expect(isPositiveNonZeroAmount(1)).toBe(true);
    expect(isPositiveNonZeroAmount(-1)).toBe(false);
  });

  it('isValidCreditAmount should accept negative numbers', () => {
    expect(isValidCreditAmount(-100)).toBe(true);
    expect(isValidCreditAmount(0)).toBe(true);
    expect(isValidCreditAmount(100)).toBe(true);
    expect(isValidCreditAmount(NaN)).toBe(false);
  });

  it('isValidCreditNonZeroAmount should reject zero', () => {
    expect(isValidCreditNonZeroAmount(0)).toBe(false);
    expect(isValidCreditNonZeroAmount(-50)).toBe(true);
    expect(isValidCreditNonZeroAmount(50)).toBe(true);
  });
});

describe('Date validations', () => {
  it('isPastDate should detect past dates', () => {
    expect(isPastDate('2020-01-01')).toBe(true);
    expect(isPastDate('2099-01-01')).toBe(false);
  });

  it('isFutureDate should detect future dates', () => {
    expect(isFutureDate('2099-01-01')).toBe(true);
    expect(isFutureDate('2020-01-01')).toBe(false);
  });

  it('isDateAfter should verify dateB >= dateA', () => {
    expect(isDateAfter('2024-01-01', '2024-06-01')).toBe(true);
    expect(isDateAfter('2024-06-01', '2024-01-01')).toBe(false);
    expect(isDateAfter('2024-01-01', '2024-01-01')).toBe(true);
  });
});

describe('Percentage validation', () => {
  it('should accept valid percentages (0-100)', () => {
    expect(isValidPercentage(0)).toBe(true);
    expect(isValidPercentage(50)).toBe(true);
    expect(isValidPercentage(100)).toBe(true);
  });

  it('should reject out-of-range percentages', () => {
    expect(isValidPercentage(-1)).toBe(false);
    expect(isValidPercentage(101)).toBe(false);
    expect(isValidPercentage('abc')).toBe(false);
  });
});

describe('String validations', () => {
  it('isNonEmptyTrimmedString should reject empty/whitespace strings', () => {
    expect(isNonEmptyTrimmedString('hello')).toBe(true);
    expect(isNonEmptyTrimmedString('')).toBe(false);
    expect(isNonEmptyTrimmedString('   ')).toBe(false);
    expect(isNonEmptyTrimmedString(123)).toBe(false);
  });

  it('isWithinMaxLength should respect max length', () => {
    expect(isWithinMaxLength('hello', 10)).toBe(true);
    expect(isWithinMaxLength('hello world', 5)).toBe(false);
  });

  it('isWithinMinLength should respect min length', () => {
    expect(isWithinMinLength('hello', 3)).toBe(true);
    expect(isWithinMinLength('hi', 5)).toBe(false);
  });
});

describe('Unit validation', () => {
  it('should accept valid units', () => {
    expect(isValidUnit('kg')).toBe(true);
    expect(isValidUnit('m²')).toBe(true);
    expect(isValidUnit('')).toBe(true); // empty string accepted
    expect(isValidUnit('pcs')).toBe(true);
  });

  it('should reject invalid units', () => {
    expect(isValidUnit('<script>')).toBe(false);
  });
});

describe('Footer notes validation', () => {
  it('should accept valid footer notes', () => {
    expect(isValidFooterNotes('Conditions de paiement: 30 jours.')).toBe(true);
    expect(isValidFooterNotes(null)).toBe(true);
    expect(isValidFooterNotes('')).toBe(true);
  });

  it('should reject notes exceeding 2000 chars', () => {
    expect(isValidFooterNotes('a'.repeat(2001))).toBe(false);
  });
});

describe('Capital social validation', () => {
  it('should accept valid capital amounts', () => {
    expect(isValidCapitalSocial('10000')).toBe(true);
    expect(isValidCapitalSocial('10000.50')).toBe(true);
    expect(isValidCapitalSocial(null)).toBe(true); // null is allowed
  });

  it('should reject invalid capital amounts', () => {
    expect(isValidCapitalSocial('abc')).toBe(false);
    expect(isValidCapitalSocial('10.123')).toBe(false); // more than 2 decimals
  });
});

describe('RCS validation', () => {
  it('should accept valid RCS formats', () => {
    expect(isValidRCS('981 576 549 R.C.S. Paris')).toBe(true);
    expect(isValidRCS(null)).toBe(true);
  });

  it('should reject invalid RCS', () => {
    expect(isValidRCS('invalid')).toBe(false);
  });
});

describe('REQUIRED_FIELDS_BY_COMPANY_STATUS', () => {
  it('should require siret, vatNumber, capitalSocial, rcs for SARL', () => {
    expect(isFieldRequiredForCompanyStatus('siret', 'SARL')).toBe(true);
    expect(isFieldRequiredForCompanyStatus('vatNumber', 'SARL')).toBe(true);
    expect(isFieldRequiredForCompanyStatus('capitalSocial', 'SARL')).toBe(true);
    expect(isFieldRequiredForCompanyStatus('rcs', 'SARL')).toBe(true);
  });

  it('should only require siret for AUTO_ENTREPRENEUR', () => {
    expect(isFieldRequiredForCompanyStatus('siret', 'AUTO_ENTREPRENEUR')).toBe(true);
    expect(isFieldRequiredForCompanyStatus('vatNumber', 'AUTO_ENTREPRENEUR')).toBe(false);
    expect(isFieldRequiredForCompanyStatus('rcs', 'AUTO_ENTREPRENEUR')).toBe(false);
  });

  it('should require nothing for ASSOCIATION', () => {
    expect(isFieldRequiredForCompanyStatus('siret', 'ASSOCIATION')).toBe(false);
  });

  it('should return false for unknown company status', () => {
    expect(isFieldRequiredForCompanyStatus('siret', 'UNKNOWN')).toBe(false);
    expect(isFieldRequiredForCompanyStatus('siret', null)).toBe(false);
  });
});
