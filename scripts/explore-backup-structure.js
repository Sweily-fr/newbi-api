#!/usr/bin/env node

/**
 * Script d'exploration de la structure d'une sauvegarde
 * Pour comprendre comment sont organisés les fichiers
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const BACKUP_BASE_PATH = '/home/joaquim/api.newbi.fr/backups';

function exploreDirectory(dirPath, level = 0) {
  const indent = '  '.repeat(level);
  
  try {
    const items = readdirSync(dirPath);
    
    for (const item of items) {
      const itemPath = join(dirPath, item);
      const stats = statSync(itemPath);
      
      if (stats.isDirectory()) {
        console.log(`${indent}📁 ${item}/`);
        if (level < 3) { // Limiter la profondeur
          exploreDirectory(itemPath, level + 1);
        }
      } else {
        const sizeKB = Math.round(stats.size / 1024);
        console.log(`${indent}📄 ${item} (${sizeKB} KB)`);
      }
    }
  } catch (error) {
    console.log(`${indent}❌ Erreur: ${error.message}`);
  }
}

function exploreBackup(backupDate) {
  console.log('🔍 Exploration de la structure de sauvegarde');
  console.log('===========================================');
  console.log(`📅 Date de sauvegarde: ${backupDate}`);
  
  const backupPath = join(BACKUP_BASE_PATH, `backup_${backupDate}`);
  console.log(`📁 Chemin: ${backupPath}`);
  
  if (!existsSync(backupPath)) {
    console.error(`❌ Dossier de sauvegarde non trouvé: ${backupPath}`);
    return;
  }
  
  console.log('\n📋 Structure du dossier:');
  exploreDirectory(backupPath);
  
  // Chercher spécifiquement des fichiers de collections
  console.log('\n🔍 Recherche de fichiers de collections...');
  const commonCollections = ['invoices', 'quotes', 'clients', 'products', 'expenses'];
  const commonExtensions = ['.json', '.bson', '.gz', '.zip'];
  
  function searchFiles(dirPath, searchLevel = 0) {
    if (searchLevel > 2) return;
    
    try {
      const items = readdirSync(dirPath);
      
      for (const item of items) {
        const itemPath = join(dirPath, item);
        const stats = statSync(itemPath);
        
        if (stats.isDirectory()) {
          searchFiles(itemPath, searchLevel + 1);
        } else {
          // Vérifier si c'est un fichier de collection
          const fileName = item.toLowerCase();
          const hasCollectionName = commonCollections.some(col => fileName.includes(col));
          const hasKnownExtension = commonExtensions.some(ext => fileName.endsWith(ext));
          
          if (hasCollectionName || hasKnownExtension) {
            const relativePath = itemPath.replace(backupPath, '');
            console.log(`   ✅ Trouvé: ${relativePath} (${Math.round(stats.size / 1024)} KB)`);
          }
        }
      }
    } catch (error) {
      console.log(`   ❌ Erreur dans ${dirPath}: ${error.message}`);
    }
  }
  
  searchFiles(backupPath);
  
  console.log('\n💡 INFORMATIONS UTILES');
  console.log('======================');
  console.log('Si vous trouvez des fichiers avec des extensions différentes (.bson, .gz, etc.),');
  console.log('il faudra adapter les scripts de restauration pour ces formats.');
  console.log('\nSi les fichiers sont dans un sous-dossier, utilisez le chemin complet.');
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const backupDateArg = args.find(arg => arg.startsWith('--backup-date='));
const backupDate = backupDateArg ? backupDateArg.split('=')[1] : '2025-09-17_06-49-52-607Z';

console.log('🔍 Script d\'exploration de sauvegarde');
console.log('====================================');

exploreBackup(backupDate);
