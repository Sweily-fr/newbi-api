/**
 * Migration script: Encrypt existing IBAN and BIC fields in the database
 *
 * Usage: DATA_ENCRYPTION_KEY=your-key node scripts/migrate-encrypt-bank-details.js
 *
 * This script:
 * 1. Finds all documents with unencrypted IBAN/BIC fields
 * 2. Encrypts them with AES-256-GCM
 * 3. Updates the documents in place
 * 4. Reports results
 *
 * Safe to run multiple times: already-encrypted values are skipped.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { encrypt, isEncrypted } from '../src/utils/encryption.js';

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is required');
  process.exit(1);
}

if (!process.env.DATA_ENCRYPTION_KEY) {
  console.error('ERROR: DATA_ENCRYPTION_KEY environment variable is required');
  process.exit(1);
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function buildSetObject(fields, doc) {
  const $set = {};
  let needsUpdate = false;

  for (const field of fields) {
    const value = getNestedValue(doc, field);
    if (value && typeof value === 'string' && !isEncrypted(value)) {
      $set[field] = encrypt(value);
      needsUpdate = true;
    }
  }

  return { $set, needsUpdate };
}

async function migrateCollection(db, collectionName, fields) {
  const collection = db.collection(collectionName);

  // Only fetch documents that have at least one of the target fields
  const orConditions = fields.map((f) => ({ [f]: { $exists: true, $nin: [null, ''] } }));
  const docs = await collection.find({ $or: orConditions }).toArray();

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const { $set, needsUpdate } = buildSetObject(fields, doc);

    if (needsUpdate) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set });
        updated++;
      } catch (err) {
        console.error(`  Error updating ${collectionName} doc ${doc._id}:`, err.message);
        errors++;
      }
    } else {
      skipped++;
    }
  }

  console.log(
    `  ${collectionName}: ${docs.length} found, ${updated} encrypted, ${skipped} already encrypted, ${errors} errors`
  );
}

async function main() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('Connected. Starting encryption migration...\n');

  // Collections using bankDetailsSchema (via companyInfo or directly)
  const bankDetailFields = ['bankDetails.iban', 'bankDetails.bic'];
  const companyInfoBankFields = ['companyInfo.bankDetails.iban', 'companyInfo.bankDetails.bic'];

  // Invoice: bankDetails + companyInfo.bankDetails
  await migrateCollection(db, 'invoices', [...bankDetailFields, ...companyInfoBankFields]);

  // CreditNote: bankDetails + companyInfo.bankDetails
  await migrateCollection(db, 'creditnotes', [...bankDetailFields, ...companyInfoBankFields]);

  // InvoiceTemplate: bankDetails only
  await migrateCollection(db, 'invoicetemplates', bankDetailFields);

  // User: companyInfo.bankDetails
  await migrateCollection(db, 'user', companyInfoBankFields);

  // Withdrawal: bankDetails (inline)
  await migrateCollection(db, 'withdrawals', bankDetailFields);

  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
