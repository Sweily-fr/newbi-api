/**
 * Service pour générer des icônes de réseaux sociaux personnalisées
 * Télécharge les SVG depuis Cloudflare et les combine avec le logo de l'entreprise
 */

import sharp from 'sharp';
import fetch from 'node-fetch';
import cloudflareService from './cloudflareService.js';

class SocialIconService {
  constructor() {
    // URLs des SVG des réseaux sociaux sur Cloudflare
    this.socialSvgUrls = {
      facebook: 'https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/facebook.svg',
      instagram: 'https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/instagram.svg',
      linkedin: 'https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/linkedin.svg',
      x: 'https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/x.svg'
    };

    // Taille des icônes générées
    this.iconSize = 32;
    this.logoSize = 20; // Taille du logo dans l'icône
  }

  /**
   * Télécharge un SVG depuis une URL
   * @param {string} url - URL du SVG
   * @returns {Promise<Buffer>} - Buffer du SVG
   */
  async downloadSvg(url) {
    try {
      console.log(`📥 Téléchargement SVG: ${url}`);
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.buffer();
      console.log(`✅ SVG téléchargé: ${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      console.error(`❌ Erreur téléchargement SVG ${url}:`, error.message);
      throw new Error(`Échec du téléchargement SVG: ${error.message}`);
    }
  }

  /**
   * Convertit un SVG en PNG avec Sharp
   * @param {Buffer} svgBuffer - Buffer du SVG
   * @param {number} size - Taille de sortie en pixels
   * @returns {Promise<Buffer>} - Buffer du PNG
   */
  async svgToPng(svgBuffer, size = this.iconSize) {
    try {
      console.log(`🔄 Conversion SVG vers PNG (${size}x${size})`);
      
      const pngBuffer = await sharp(svgBuffer)
        .resize(size, size)
        .png({
          quality: 100,
          compressionLevel: 6,
          adaptiveFiltering: false
        })
        .toBuffer();

      console.log(`✅ PNG généré: ${pngBuffer.length} bytes`);
      return pngBuffer;
    } catch (error) {
      console.error('❌ Erreur conversion SVG vers PNG:', error.message);
      throw new Error(`Échec conversion SVG vers PNG: ${error.message}`);
    }
  }

  /**
   * Télécharge et redimensionne le logo de l'entreprise
   * @param {string} logoUrl - URL du logo de l'entreprise
   * @returns {Promise<Buffer>} - Buffer du logo redimensionné
   */
  async downloadAndResizeLogo(logoUrl) {
    try {
      console.log(`📥 Téléchargement logo entreprise: ${logoUrl}`);
      const response = await fetch(logoUrl);
      
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status}: ${response.statusText}`);
      }

      const logoBuffer = await response.buffer();
      
      // Redimensionner le logo pour qu'il s'intègre dans l'icône
      const resizedLogo = await sharp(logoBuffer)
        .resize(this.logoSize, this.logoSize, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .png()
        .toBuffer();

      console.log(`✅ Logo redimensionné: ${resizedLogo.length} bytes`);
      return resizedLogo;
    } catch (error) {
      console.error(`❌ Erreur téléchargement logo:`, error.message);
      throw new Error(`Échec téléchargement logo: ${error.message}`);
    }
  }

  /**
   * Combine l'icône sociale avec le logo de l'entreprise
   * @param {Buffer} socialIconBuffer - Buffer de l'icône sociale (PNG)
   * @param {Buffer} logoBuffer - Buffer du logo de l'entreprise (PNG)
   * @returns {Promise<Buffer>} - Buffer de l'icône combinée
   */
  async combineIconWithLogo(socialIconBuffer, logoBuffer) {
    try {
      console.log('🎨 Combinaison icône sociale + logo entreprise');
      
      // Créer l'icône combinée avec le logo en overlay
      const combinedIcon = await sharp(socialIconBuffer)
        .composite([
          {
            input: logoBuffer,
            top: this.iconSize - this.logoSize - 2, // Position en bas à droite
            left: this.iconSize - this.logoSize - 2,
            blend: 'over'
          }
        ])
        .png({
          quality: 100,
          compressionLevel: 6
        })
        .toBuffer();

      console.log(`✅ Icône combinée générée: ${combinedIcon.length} bytes`);
      return combinedIcon;
    } catch (error) {
      console.error('❌ Erreur combinaison icône + logo:', error.message);
      throw new Error(`Échec combinaison icône + logo: ${error.message}`);
    }
  }

  /**
   * Génère toutes les icônes sociales personnalisées pour une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} logoUrl - URL du logo de l'entreprise
   * @returns {Promise<Object>} - URLs des icônes générées
   */
  async generateCustomSocialIcons(userId, signatureId, logoUrl) {
    try {
      console.log(`🚀 Génération icônes sociales personnalisées pour signature ${signatureId}`);
      
      if (!logoUrl) {
        throw new Error('URL du logo entreprise requise');
      }

      // Télécharger et redimensionner le logo de l'entreprise
      const logoBuffer = await this.downloadAndResizeLogo(logoUrl);
      
      const generatedIcons = {};

      // Générer chaque icône sociale
      for (const [platform, svgUrl] of Object.entries(this.socialSvgUrls)) {
        try {
          console.log(`🔄 Génération icône ${platform}`);
          
          // 1. Télécharger le SVG de la plateforme
          const svgBuffer = await this.downloadSvg(svgUrl);
          
          // 2. Convertir le SVG en PNG
          const socialIconBuffer = await this.svgToPng(svgBuffer);
          
          // 3. Combiner avec le logo de l'entreprise
          const combinedIconBuffer = await this.combineIconWithLogo(socialIconBuffer, logoBuffer);
          
          // 4. Uploader vers Cloudflare dans le dossier logo/platform/
          const fileName = `${platform}-custom.png`;
          const uploadResult = await cloudflareService.uploadSocialLogo(
            combinedIconBuffer,
            fileName,
            userId,
            signatureId,
            platform // Type de logo social (facebook, instagram, etc.)
          );
          
          generatedIcons[platform] = {
            url: uploadResult.url,
            key: uploadResult.key
          };
          
          console.log(`✅ Icône ${platform} générée: ${uploadResult.url}`);
          
        } catch (error) {
          console.error(`❌ Erreur génération icône ${platform}:`, error.message);
          // Continuer avec les autres icônes même si une échoue
        }
      }

      console.log(`✅ Génération terminée: ${Object.keys(generatedIcons).length} icônes créées`);
      return generatedIcons;
      
    } catch (error) {
      console.error('❌ Erreur génération icônes sociales:', error.message);
      throw new Error(`Échec génération icônes sociales: ${error.message}`);
    }
  }

  /**
   * Supprime les icônes sociales personnalisées d'une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<boolean>} - Succès de la suppression
   */
  async deleteCustomSocialIcons(userId, signatureId) {
    try {
      console.log(`🗑️ Suppression icônes sociales pour signature ${signatureId}`);
      
      // Supprimer le dossier logo qui contient toutes les icônes sociales
      const result = await cloudflareService.deleteSocialLogos(userId, signatureId);
      
      console.log(`✅ Icônes sociales supprimées: ${result}`);
      return result;
      
    } catch (error) {
      console.error('❌ Erreur suppression icônes sociales:', error.message);
      return false;
    }
  }

  /**
   * Met à jour les icônes sociales quand le logo change
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} newLogoUrl - Nouvelle URL du logo
   * @returns {Promise<Object>} - URLs des nouvelles icônes
   */
  async updateCustomSocialIcons(userId, signatureId, newLogoUrl) {
    try {
      console.log(`🔄 Mise à jour icônes sociales pour signature ${signatureId}`);
      
      // Supprimer les anciennes icônes
      await this.deleteCustomSocialIcons(userId, signatureId);
      
      // Générer les nouvelles icônes
      const newIcons = await this.generateCustomSocialIcons(userId, signatureId, newLogoUrl);
      
      console.log(`✅ Icônes sociales mises à jour`);
      return newIcons;
      
    } catch (error) {
      console.error('❌ Erreur mise à jour icônes sociales:', error.message);
      throw new Error(`Échec mise à jour icônes sociales: ${error.message}`);
    }
  }
}

// Instance singleton
const socialIconService = new SocialIconService();

export default socialIconService;
