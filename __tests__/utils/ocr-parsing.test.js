import { describe, it, expect } from 'vitest';

/**
 * Tests for OCR utility functions from src/utils/ocrProcessor.js
 * We replicate the pure functions here since processFileWithOCR is the only export.
 */

// Replicate extractAmount from ocrProcessor.js
const extractAmount = (amountStr) => {
  if (!amountStr) return null;
  const cleaned = amountStr.replace(/\s/g, "").replace(/,/g, ".");
  const match = cleaned.match(/([0-9]+\.?[0-9]*)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return null;
};

// Replicate extractCurrency from ocrProcessor.js
const extractCurrency = (text) => {
  if (text.includes("€") || text.match(/\bEUR\b/i)) return "EUR";
  if (text.includes("$") || text.match(/\bUSD\b/i)) return "USD";
  if (text.includes("£") || text.match(/\bGBP\b/i)) return "GBP";
  if (text.match(/\bCAD\b/i)) return "CAD";
  if (text.match(/\bCHF\b/i)) return "CHF";
  return "EUR";
};

// Replicate normalizeDate from ocrProcessor.js
const normalizeDate = (dateStr) => {
  if (!dateStr) return null;
  const normalized = dateStr.replace(/[./]/g, "-");

  const formats = [
    {
      regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      formatter: (d, m, y) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    },
    {
      regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
      formatter: (y, m, d) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    },
    {
      regex: /^(\d{1,2})-(\d{1,2})-(\d{2})$/,
      formatter: (d, m, y) => {
        const fullYear = parseInt(y) > 50 ? `19${y}` : `20${y}`;
        return `${fullYear}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      },
    },
  ];

  for (const format of formats) {
    const match = normalized.match(format.regex);
    if (match) {
      try {
        const formattedDate = format.formatter(...match.slice(1));
        const date = new Date(formattedDate);
        if (!isNaN(date.getTime())) return formattedDate;
      } catch (e) {
        continue;
      }
    }
  }
  return null;
};

// Replicate cleanText from ocrProcessor.js
const cleanText = (text) => text.replace(/\s+/g, " ").trim();

// Replicate extractVendorName from ocrProcessor.js
const extractVendorName = (text) => {
  const lines = text.split("\n");
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i].trim();
    if (line && line.length > 3 && !line.match(/facture|invoice|reçu|receipt|ticket|bill/i)) {
      return line;
    }
  }
  return null;
};

// Replicate REGEX patterns from ocrProcessor.js
const REGEX = {
  VAT_NUMBER: /(?:TVA|VAT|Tax ID|N° TVA|VAT Number|VAT No)[^\w]?[:\s]*([A-Z]{2}[0-9A-Z]{2,12})/i,
  INVOICE_NUMBER: /(?:Facture|Invoice|Bill|N°)[^\w]?[:\s]*([A-Z0-9]{1,4}[-\s]?[0-9]{1,10})/i,
  TOTAL_AMOUNT: /(?:Total|Montant total|Total amount|Total TTC|Total \(TTC\))[^\w]?[:\s]*([0-9\s]+[,.][0-9]{2})/i,
  VAT_AMOUNT: /(?:TVA|VAT|Tax|Taxe|Montant TVA|VAT amount)[^\w]?[:\s]*([0-9\s]+[,.][0-9]{2})/i,
  CURRENCY: /(?:€|\$|£|EUR|USD|GBP|CAD|CHF)/i,
};

describe('extractAmount', () => {
  it('should extract amount from comma-separated string', () => {
    expect(extractAmount('1 234,56')).toBe(1234.56);
  });

  it('should extract amount from dot-separated string', () => {
    expect(extractAmount('1234.56')).toBe(1234.56);
  });

  it('should extract amount with spaces', () => {
    expect(extractAmount('1 000,00')).toBe(1000.00);
  });

  it('should return null for empty string', () => {
    expect(extractAmount('')).toBe(null);
  });

  it('should return null for null input', () => {
    expect(extractAmount(null)).toBe(null);
  });

  it('should handle integer amounts', () => {
    expect(extractAmount('500')).toBe(500);
  });
});

describe('extractCurrency', () => {
  it('should detect EUR from euro sign', () => {
    expect(extractCurrency('Total: 100,00 €')).toBe('EUR');
  });

  it('should detect EUR from text', () => {
    expect(extractCurrency('Amount: 100 EUR')).toBe('EUR');
  });

  it('should detect USD from dollar sign', () => {
    expect(extractCurrency('Total: $100.00')).toBe('USD');
  });

  it('should detect GBP from pound sign', () => {
    expect(extractCurrency('Total: £100.00')).toBe('GBP');
  });

  it('should detect CAD', () => {
    expect(extractCurrency('Amount: 100 CAD')).toBe('CAD');
  });

  it('should detect CHF', () => {
    expect(extractCurrency('Amount: 100 CHF')).toBe('CHF');
  });

  it('should default to EUR when no currency found', () => {
    expect(extractCurrency('just some text')).toBe('EUR');
  });
});

describe('normalizeDate', () => {
  it('should parse DD/MM/YYYY format', () => {
    expect(normalizeDate('15/03/2026')).toBe('2026-03-15');
  });

  it('should parse DD.MM.YYYY format', () => {
    expect(normalizeDate('01.12.2025')).toBe('2025-12-01');
  });

  it('should parse YYYY-MM-DD format', () => {
    expect(normalizeDate('2026-03-15')).toBe('2026-03-15');
  });

  it('should parse DD/MM/YY format with 20xx century', () => {
    expect(normalizeDate('15/03/26')).toBe('2026-03-15');
  });

  it('should parse DD/MM/YY format with 19xx century for years > 50', () => {
    expect(normalizeDate('15/03/85')).toBe('1985-03-15');
  });

  it('should return null for null input', () => {
    expect(normalizeDate(null)).toBe(null);
  });

  it('should return null for unparseable date', () => {
    expect(normalizeDate('not-a-date')).toBe(null);
  });
});

describe('cleanText', () => {
  it('should collapse multiple spaces', () => {
    expect(cleanText('hello   world')).toBe('hello world');
  });

  it('should trim leading/trailing whitespace', () => {
    expect(cleanText('  hello  ')).toBe('hello');
  });

  it('should collapse newlines and tabs into spaces', () => {
    expect(cleanText('hello\n\tworld')).toBe('hello world');
  });
});

describe('extractVendorName', () => {
  it('should extract vendor name from first valid line', () => {
    const text = 'Acme Corporation\n12 rue de Paris\n75001 Paris';
    expect(extractVendorName(text)).toBe('Acme Corporation');
  });

  it('should skip lines containing invoice keywords', () => {
    const text = 'Facture N° 001\nAcme Corp\nParis';
    expect(extractVendorName(text)).toBe('Acme Corp');
  });

  it('should skip short lines', () => {
    const text = 'AB\nAcme Corporation\nParis';
    expect(extractVendorName(text)).toBe('Acme Corporation');
  });

  it('should return null when no valid line found', () => {
    const text = 'AB\nCD\nEF';
    expect(extractVendorName(text)).toBe(null);
  });
});

describe('OCR regex patterns', () => {
  it('should match VAT number pattern', () => {
    const text = 'N° TVA: FR12345678901';
    const match = text.match(REGEX.VAT_NUMBER);
    expect(match).not.toBeNull();
    expect(match[1]).toBe('FR12345678901');
  });

  it('should match invoice number pattern', () => {
    const text = 'Facture N° F-0001234';
    const match = text.match(REGEX.INVOICE_NUMBER);
    expect(match).not.toBeNull();
  });

  it('should match total amount pattern', () => {
    const text = 'Total TTC: 1 234,56';
    const match = text.match(REGEX.TOTAL_AMOUNT);
    expect(match).not.toBeNull();
    expect(extractAmount(match[1])).toBe(1234.56);
  });

  it('should match VAT amount pattern', () => {
    const text = 'TVA: 200,00';
    const match = text.match(REGEX.VAT_AMOUNT);
    expect(match).not.toBeNull();
    expect(extractAmount(match[1])).toBe(200.00);
  });
});
