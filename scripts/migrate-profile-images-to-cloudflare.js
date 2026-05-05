#!/usr/bin/env node

/**
 * Script de migration des images de profil vers Cloudflare R2
 * Transfère les images depuis src/public/uploads/profile-pictures vers le bucket profil
 * Met à jour les liens en base de données
 * Usage: node scripts/migrate-profile-images-to-cloudflare.js [--apply]
 */

import { MongoClient, ObjectId } from 'mongodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
const DB_NAME = 'newbi';
const PROFILE_IMAGES_PATH = '/home/joaquim/api.newbi.fr/src/public/uploads/profile-pictures';

// Configuration Cloudflare R2 pour les profils
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.AWS_S3_API_URL,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const PROFILE_BUCKET = process.env.AWS_S3_BUCKET_NAME_IMG_PROFILE || process.env.AWS_S3_BUCKET_NAME_IMG || 'newbi-user-profiles';
const PROFILE_PUBLIC_URL = process.env.AWS_R2_PUBLIC_URL_IMG || process.env.AWS_R2_PUBLIC_URL || 'https://pub-afeb8647684e476ca05894fe1df797fb.r2.dev';

// Statistiques globales
const stats = {
  usersFound: 0,
  imagesFound: 0,
  imagesUploaded: 0,
  usersUpdated: 0,
  errors: 0,
  skipped: 0
};

/**
 * Détermine le content-type basé sur l'extension
 */
function getContentType(extension) {
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp'
  };
  return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
}

/**
 * Upload une image vers Cloudflare R2
 */
async function uploadImageToCloudflare(filePath, userId, originalFileName) {
  try {
    console.log(`    📤 Upload vers Cloudflare: ${originalFileName}`);
    
    // Lire le fichier
    const fileBuffer = readFileSync(filePath);
    const fileExtension = extname(originalFileName).toLowerCase();
    const uniqueId = uuidv4();
    
    // Générer la clé selon le format requis
    const key = `${userId}/image/${uniqueId}${fileExtension}`;
    
    // Déterminer le content-type
    const contentType = getContentType(fileExtension);
    
    // Commande d'upload
    const command = new PutObjectCommand({
      Bucket: PROFILE_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000', // Cache 1 an
      Metadata: {
        userId: userId,
        imageType: 'profile',
        originalName: originalFileName,
        uploadedAt: new Date().toISOString(),
        migratedFrom: 'local-server'
      },
    });
    
    await s3Client.send(command);
    
    // Générer l'URL publique
    const imageUrl = `${PROFILE_PUBLIC_URL}/${key}`;
    
    console.log(`    ✅ Upload réussi: ${imageUrl}`);
    
    return {
      key,
      url: imageUrl,
      size: fileBuffer.length
    };
    
  } catch (error) {
    console.error(`    ❌ Erreur upload ${originalFileName}:`, error.message);
    throw error;
  }
}

/**
 * Trouve les images de profil locales
 */
function findLocalProfileImages() {
  console.log('🔍 Recherche des images de profil locales...');
  console.log(`📁 Chemin: ${PROFILE_IMAGES_PATH}`);
  
  if (!existsSync(PROFILE_IMAGES_PATH)) {
    console.log('⚠️  Dossier des images de profil non trouvé');
    return [];
  }
  
  const images = [];
  const files = readdirSync(PROFILE_IMAGES_PATH);
  
  for (const file of files) {
    const filePath = join(PROFILE_IMAGES_PATH, file);
    const fileStat = statSync(filePath);
    
    if (fileStat.isFile()) {
      const extension = extname(file).toLowerCase();
      const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
      
      if (validExtensions.includes(extension)) {
        images.push({
          fileName: file,
          filePath: filePath,
          size: fileStat.size,
          extension: extension
        });
      }
    }
  }
  
  console.log(`📊 ${images.length} images trouvées`);
  stats.imagesFound = images.length;
  
  return images;
}

/**
 * Trouve les utilisateurs avec des images de profil locales
 */
async function findUsersWithProfileImages(db) {
  console.log('👥 Recherche des utilisateurs avec images de profil...');
  
  // Chercher les utilisateurs avec des profileImageUrl pointant vers le serveur local
  const users = await db.collection('user').find({
    profileImageUrl: { 
      $exists: true, 
      $ne: null,
      $regex: /uploads\/profile-pictures/
    }
  }).toArray();
  
  console.log(`📊 ${users.length} utilisateurs avec images de profil locales trouvés`);
  stats.usersFound = users.length;
  
  return users;
}

/**
 * Extrait le nom de fichier depuis l'URL de profil
 */
function extractFileNameFromUrl(profileImageUrl) {
  if (!profileImageUrl) return null;
  
  // Extraire le nom de fichier depuis l'URL
  // Format attendu: /uploads/profile-pictures/filename.ext ou similaire
  const match = profileImageUrl.match(/profile-pictures\/([^/?]+)/);
  return match ? match[1] : null;
}

/**
 * Migre les images d'un utilisateur
 */
async function migrateUserImages(db, user, localImages, isDryRun = true) {
  console.log(`\n👤 Utilisateur: ${user.email || user._id} (${user._id})`);
  console.log(`   📷 Image actuelle: ${user.profileImageUrl}`);
  
  // Extraire le nom de fichier depuis l'URL
  const fileName = extractFileNameFromUrl(user.profileImageUrl);
  if (!fileName) {
    console.log('   ⚠️  Impossible d\'extraire le nom de fichier');
    stats.skipped++;
    return;
  }
  
  // Trouver l'image locale correspondante
  const localImage = localImages.find(img => img.fileName === fileName);
  if (!localImage) {
    console.log(`   ❌ Image locale non trouvée: ${fileName}`);
    stats.errors++;
    return;
  }
  
  console.log(`   📁 Image trouvée: ${localImage.filePath} (${Math.round(localImage.size / 1024)} KB)`);
  
  if (isDryRun) {
    console.log('   🔍 Mode simulation - image serait uploadée vers Cloudflare');
    console.log(`   🌐 URL cible: ${PROFILE_PUBLIC_URL}/${user._id}/image/{uuid}${localImage.extension}`);
    return;
  }
  
  try {
    // Upload vers Cloudflare
    const uploadResult = await uploadImageToCloudflare(
      localImage.filePath,
      user._id.toString(),
      localImage.fileName
    );
    
    stats.imagesUploaded++;
    
    // Mettre à jour l'utilisateur en base
    const updateResult = await db.collection('user').updateOne(
      { _id: user._id },
      { 
        $set: { 
          profileImageUrl: uploadResult.url,
          profileImageKey: uploadResult.key, // Garder la clé pour référence
          profileImageMigratedAt: new Date()
        }
      }
    );
    
    if (updateResult.modifiedCount > 0) {
      console.log(`   ✅ Utilisateur mis à jour avec nouvelle URL: ${uploadResult.url}`);
      stats.usersUpdated++;
    } else {
      console.log('   ⚠️  Échec de la mise à jour en base');
      stats.errors++;
    }
    
  } catch (error) {
    console.error(`   ❌ Erreur migration:`, error.message);
    stats.errors++;
  }
}

/**
 * Fonction principale de migration
 */
async function migrateProfileImages(isDryRun = true) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Migration des images de profil vers Cloudflare R2');
    console.log('==================================================');
    console.log(`📋 Mode: ${isDryRun ? 'SIMULATION (dry-run)' : 'MIGRATION RÉELLE'}`);
    console.log(`🪣 Bucket cible: ${PROFILE_BUCKET}`);
    console.log(`🌐 URL publique: ${PROFILE_PUBLIC_URL}`);
    console.log('');
    
    // Vérifier la configuration
    if (!PROFILE_PUBLIC_URL || PROFILE_PUBLIC_URL === 'https://your_profile_public_url') {
      throw new Error('AWS_R2_PUBLIC_URL_IMG non configurée');
    }
    
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    
    // 1. Trouver les images locales
    const localImages = findLocalProfileImages();
    if (localImages.length === 0) {
      console.log('⚠️  Aucune image locale trouvée - arrêt du script');
      return;
    }
    
    // 2. Trouver les utilisateurs avec images de profil
    const users = await findUsersWithProfileImages(db);
    if (users.length === 0) {
      console.log('⚠️  Aucun utilisateur avec image de profil locale - arrêt du script');
      return;
    }
    
    console.log('\n📊 ANALYSE PRÉLIMINAIRE');
    console.log('======================');
    console.log(`📷 Images locales trouvées: ${localImages.length}`);
    console.log(`👥 Utilisateurs à migrer: ${users.length}`);
    
    // Analyser la correspondance
    let matches = 0;
    for (const user of users) {
      const fileName = extractFileNameFromUrl(user.profileImageUrl);
      if (fileName && localImages.find(img => img.fileName === fileName)) {
        matches++;
      }
    }
    console.log(`🔗 Correspondances trouvées: ${matches}`);
    
    if (isDryRun) {
      console.log('\n💡 Pour appliquer la migration, relancez avec --apply');
      console.log('⚠️  Assurez-vous d\'avoir une sauvegarde de la base de données !');
    }
    
    // 3. Migrer chaque utilisateur
    console.log('\n🔄 MIGRATION DES IMAGES');
    console.log('======================');
    
    for (const user of users) {
      await migrateUserImages(db, user, localImages, isDryRun);
    }
    
    // 4. Résumé final
    console.log('\n📊 RÉSUMÉ DE LA MIGRATION');
    console.log('=========================');
    console.log(`👥 Utilisateurs analysés: ${stats.usersFound}`);
    console.log(`📷 Images locales trouvées: ${stats.imagesFound}`);
    console.log(`📤 Images uploadées: ${stats.imagesUploaded}`);
    console.log(`✅ Utilisateurs mis à jour: ${stats.usersUpdated}`);
    console.log(`⏭️  Utilisateurs ignorés: ${stats.skipped}`);
    console.log(`❌ Erreurs rencontrées: ${stats.errors}`);
    
    if (!isDryRun && stats.imagesUploaded > 0) {
      console.log('\n🎉 Migration terminée avec succès !');
      console.log('💡 Les anciennes images locales peuvent maintenant être supprimées');
      console.log('🔍 Vérifiez que les images s\'affichent correctement dans l\'interface');
    }
    
  } catch (error) {
    console.error('❌ Erreur générale:', error.message);
    stats.errors++;
  } finally {
    await client.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const isDryRun = !args.includes('--apply');

console.log('📷 Script de migration des images de profil vers Cloudflare R2');
console.log('==============================================================');

if (isDryRun) {
  console.log('ℹ️  Mode SIMULATION activé (aucune modification ne sera appliquée)');
  console.log('💡 Utilisez --apply pour appliquer la migration');
} else {
  console.log('⚠️  Mode MIGRATION RÉELLE activé');
  console.log('🚨 Les images seront uploadées et les URLs mises à jour !');
}

console.log('\nOptions disponibles:');
console.log('  --apply    Appliquer la migration (sinon simulation)');
console.log('\nExemples:');
console.log('  node scripts/migrate-profile-images-to-cloudflare.js');
console.log('  node scripts/migrate-profile-images-to-cloudflare.js --apply');

// Fonction principale async
async function main() {
  // Demander confirmation si ce n'est pas un dry-run
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Vous êtes sur le point de migrer les images de profil !');
    console.log('📋 Cette opération va :');
    console.log('   1. Uploader les images vers Cloudflare R2');
    console.log('   2. Modifier les URLs en base de données');
    console.log('   3. Les anciennes images locales resteront en place');
    console.log('\nAppuyez sur Ctrl+C pour annuler, ou attendez 5 secondes pour continuer...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await migrateProfileImages(isDryRun);
}

main().catch(console.error);
