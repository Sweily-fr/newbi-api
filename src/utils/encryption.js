import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('DATA_ENCRYPTION_KEY environment variable is required');
  }
  // Ensure key is exactly 32 bytes for AES-256
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns format: iv:authTag:encryptedData (all hex-encoded)
 */
export function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt().
 * Gracefully handles unencrypted values (for migration compatibility).
 */
export function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  // If the text doesn't match our format, it's unencrypted (pre-migration data)
  if (!isEncrypted(encryptedText)) return encryptedText;
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Check if a string appears to be encrypted (matches iv:authTag:data format).
 * IV is 16 bytes = 32 hex chars, authTag is 16 bytes = 32 hex chars.
 */
export function isEncrypted(text) {
  if (!text || typeof text !== 'string') return false;
  const parts = text.split(':');
  if (parts.length !== 3) return false;
  return parts[0].length === 32 && parts[1].length === 32 && /^[0-9a-f]+$/.test(parts[0]) && /^[0-9a-f]+$/.test(parts[1]);
}

/**
 * Encrypt IBAN and BIC fields in a bankDetails object.
 * Returns a new object with encrypted values; other fields are preserved.
 */
export function encryptBankDetails(bankDetails) {
  if (!bankDetails) return bankDetails;
  const result = typeof bankDetails.toObject === 'function' ? bankDetails.toObject() : { ...bankDetails };
  if (result.iban && !isEncrypted(result.iban)) {
    result.iban = encrypt(result.iban);
  }
  if (result.bic && !isEncrypted(result.bic)) {
    result.bic = encrypt(result.bic);
  }
  return result;
}

/**
 * Decrypt IBAN and BIC fields in a bankDetails object.
 * Returns a new object with decrypted values; other fields are preserved.
 */
export function decryptBankDetails(bankDetails) {
  if (!bankDetails) return bankDetails;
  const result = typeof bankDetails.toObject === 'function' ? bankDetails.toObject() : { ...bankDetails };
  if (result.iban) result.iban = decrypt(result.iban);
  if (result.bic) result.bic = decrypt(result.bic);
  return result;
}

/**
 * Apply encryption hooks to a Mongoose schema that has bankDetails fields.
 *
 * @param {mongoose.Schema} schema - The Mongoose schema to add hooks to
 * @param {string[]} bankDetailsPaths - Array of paths to bankDetails subdocuments
 *   e.g. ['bankDetails', 'companyInfo.bankDetails']
 */
export function applyBankDetailsEncryption(schema, bankDetailsPaths) {
  // Pre-save: encrypt IBAN/BIC before writing to DB
  schema.pre('save', function (next) {
    for (const path of bankDetailsPaths) {
      const bd = getNestedValue(this, path);
      if (bd) {
        if (bd.iban && !isEncrypted(bd.iban)) {
          setNestedValue(this, `${path}.iban`, encrypt(bd.iban));
        }
        if (bd.bic && !isEncrypted(bd.bic)) {
          setNestedValue(this, `${path}.bic`, encrypt(bd.bic));
        }
      }
    }
    next();
  });

  // Pre-findOneAndUpdate: encrypt IBAN/BIC in update operations
  schema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate();
    if (!update) return next();

    // Handle $set operator
    const targets = [update, update.$set].filter(Boolean);
    for (const target of targets) {
      for (const path of bankDetailsPaths) {
        // Direct field paths like 'bankDetails.iban'
        const ibanKey = `${path}.iban`;
        const bicKey = `${path}.bic`;
        if (target[ibanKey] && !isEncrypted(target[ibanKey])) {
          target[ibanKey] = encrypt(target[ibanKey]);
        }
        if (target[bicKey] && !isEncrypted(target[bicKey])) {
          target[bicKey] = encrypt(target[bicKey]);
        }
        // Nested object like bankDetails: { iban: '...', bic: '...' }
        const bd = getNestedValue(target, path);
        if (bd && typeof bd === 'object') {
          if (bd.iban && !isEncrypted(bd.iban)) {
            bd.iban = encrypt(bd.iban);
          }
          if (bd.bic && !isEncrypted(bd.bic)) {
            bd.bic = encrypt(bd.bic);
          }
        }
      }
    }
    next();
  });

  // Post-find hooks: decrypt IBAN/BIC after reading from DB
  const decryptDoc = (doc) => {
    if (!doc) return;
    for (const path of bankDetailsPaths) {
      const bd = getNestedValue(doc, path);
      if (bd) {
        if (bd.iban && isEncrypted(bd.iban)) {
          setNestedValue(doc, `${path}.iban`, decrypt(bd.iban));
        }
        if (bd.bic && isEncrypted(bd.bic)) {
          setNestedValue(doc, `${path}.bic`, decrypt(bd.bic));
        }
      }
    }
  };

  schema.post('find', function (docs) {
    if (Array.isArray(docs)) {
      docs.forEach(decryptDoc);
    }
  });

  schema.post('findOne', function (doc) {
    decryptDoc(doc);
  });

  schema.post('findOneAndUpdate', function (doc) {
    decryptDoc(doc);
  });

  schema.post('save', function (doc) {
    decryptDoc(doc);
  });
}

// Helpers for nested property access
function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    if (current && typeof current === 'object') {
      // Support Mongoose documents with get()
      return typeof current.get === 'function' ? current.get(key) : current[key];
    }
    return undefined;
  }, obj);
}

function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  const target = keys.reduce((current, key) => {
    if (current && typeof current === 'object') {
      return typeof current.get === 'function' ? current.get(key) : current[key];
    }
    return undefined;
  }, obj);
  if (target && typeof target === 'object') {
    if (typeof target.set === 'function' && typeof target.schema !== 'undefined') {
      target.set(lastKey, value);
    } else {
      target[lastKey] = value;
    }
  }
}
