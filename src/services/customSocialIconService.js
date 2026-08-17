import logger from "../utils/logger.js";
import axios from "axios";
import CloudflareService from "./cloudflareService.js";

class CustomSocialIconService {
  constructor() {
    this.baseUrls = {
      facebook:
        "https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/facebook.svg",
      instagram:
        "https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/instagram.svg",
      linkedin:
        "https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/linkedin.svg",
      x: "https://pub-4ab56834c87d44b9a4fee1c84196b095.r2.dev/x.svg",
    };
  }

  /**
   * Télécharge un SVG et modifie sa couleur
   * @param {string} platform - La plateforme (facebook, instagram, linkedin, x)
   * @param {string} color - La couleur hexadécimale (ex: #FF0000)
   * @returns {Promise<string>} Le SVG modifié
   */
  async generateColoredSvg(platform, color) {
    try {
      logger.debug(
        `🎨 Génération SVG coloré pour ${platform} avec couleur ${color}`,
      );

      // Télécharger le SVG original
      const response = await axios.get(this.baseUrls[platform]);
      let svgContent = response.data;

      // Modifier la couleur du SVG
      // Cette approche simple remplace les couleurs existantes par la nouvelle couleur
      svgContent = this.applySvgColor(svgContent, color, platform);

      logger.debug(`✅ SVG coloré généré pour ${platform}`);
      return svgContent;
    } catch (error) {
      console.error(
        `❌ Erreur lors de la génération du SVG coloré pour ${platform}:`,
        error.message,
      );
      throw new Error(
        `Impossible de générer le SVG coloré pour ${platform}: ${error.message}`,
      );
    }
  }

  /**
   * Applique une couleur à un SVG selon la plateforme
   * @param {string} svgContent - Le contenu SVG original
   * @param {string} color - La couleur hexadécimale
   * @param {string} platform - La plateforme
   * @returns {string} Le SVG avec la nouvelle couleur
   */
  applySvgColor(svgContent, color, platform) {
    // Stratégies de coloration selon la plateforme
    switch (platform) {
      case "linkedin":
        // LinkedIn: remplacer les couleurs bleues par la nouvelle couleur
        svgContent = svgContent.replace(/#0077B5/gi, color);
        svgContent = svgContent.replace(/#0A66C2/gi, color);
        svgContent = svgContent.replace(/fill="[^"]*"/gi, `fill="${color}"`);
        break;

      case "facebook":
        // Facebook: remplacer les couleurs bleues par la nouvelle couleur
        svgContent = svgContent.replace(/#1877F2/gi, color);
        svgContent = svgContent.replace(/#4267B2/gi, color);
        svgContent = svgContent.replace(/fill="[^"]*"/gi, `fill="${color}"`);
        break;

      case "instagram":
        // Instagram: plus complexe car c'est un dégradé, on applique une couleur unie
        svgContent = svgContent.replace(/#E4405F/gi, color);
        svgContent = svgContent.replace(/#F56040/gi, color);
        svgContent = svgContent.replace(/#FCAF45/gi, color);
        svgContent = svgContent.replace(/fill="[^"]*"/gi, `fill="${color}"`);
        // Supprimer les dégradés et utiliser une couleur unie
        svgContent = svgContent.replace(/<defs>.*?<\/defs>/gs, "");
        svgContent = svgContent.replace(
          /fill="url\([^)]*\)"/gi,
          `fill="${color}"`,
        );
        break;

      case "x":
        // X (Twitter): remplacer le noir par la nouvelle couleur
        svgContent = svgContent.replace(/#000000/gi, color);
        svgContent = svgContent.replace(/#1DA1F2/gi, color);
        svgContent = svgContent.replace(/fill="[^"]*"/gi, `fill="${color}"`);
        break;

      default:
        // Par défaut, remplacer tous les attributs fill
        svgContent = svgContent.replace(/fill="[^"]*"/gi, `fill="${color}"`);
    }

    return svgContent;
  }

  /**
   * Génère et upload une icône sociale personnalisée sur Cloudflare
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} platform - La plateforme (facebook, instagram, linkedin, x)
   * @param {string} color - La couleur hexadécimale
   * @returns {Promise<string>} L'URL de l'icône uploadée
   */
  async generateAndUploadCustomIcon(userId, signatureId, platform, color) {
    try {
      logger.debug(
        `🚀 Génération et upload icône personnalisée ${platform} pour user ${userId}, signature ${signatureId}`,
      );

      // Générer le SVG coloré
      const coloredSvg = await this.generateColoredSvg(platform, color);

      // Convertir en Buffer
      const svgBuffer = Buffer.from(coloredSvg, "utf8");

      // Créer un nom de fichier unique
      const fileName = `${platform}-${color.replace("#", "")}.svg`;

      // Upload sur Cloudflare dans le dossier customSocialIcons
      const cloudflareUrl = await CloudflareService.uploadCustomSocialIcon(
        userId,
        signatureId,
        platform,
        svgBuffer,
        fileName,
      );

      logger.debug(`✅ Icône personnalisée uploadée: ${cloudflareUrl}`);
      return cloudflareUrl;
    } catch (error) {
      console.error(
        `❌ Erreur lors de la génération et upload de l'icône ${platform}:`,
        error.message,
      );
      throw new Error(
        `Impossible de générer l'icône personnalisée ${platform}: ${error.message}`,
      );
    }
  }

  /**
   * Génère toutes les icônes personnalisées pour une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {Object} socialColors - Objet contenant les couleurs pour chaque plateforme
   * @param {Object} socialNetworks - Objet contenant les URLs des réseaux sociaux
   * @returns {Promise<Object>} Objet contenant les URLs des icônes générées
   */
  async generateAllCustomIcons(
    userId,
    signatureId,
    socialColors,
    socialNetworks,
  ) {
    try {
      logger.debug(
        `🎨 Génération de toutes les icônes personnalisées pour signature ${signatureId}`,
      );

      const customIcons = {};
      const platforms = ["facebook", "instagram", "linkedin", "x"];

      for (const platform of platforms) {
        // Ne générer que si l'utilisateur a une URL pour ce réseau social
        if (
          socialNetworks[platform] &&
          socialNetworks[platform].trim() !== ""
        ) {
          const color =
            socialColors[platform] || this.getDefaultColor(platform);

          try {
            const iconUrl = await this.generateAndUploadCustomIcon(
              userId,
              signatureId,
              platform,
              color,
            );
            customIcons[platform] = iconUrl;
          } catch (error) {
            console.error(`⚠️ Erreur pour ${platform}:`, error.message);
            // Continuer avec les autres plateformes même si une échoue
          }
        }
      }

      logger.debug(
        `✅ Icônes personnalisées générées:`,
        Object.keys(customIcons),
      );
      return customIcons;
    } catch (error) {
      console.error(
        `❌ Erreur lors de la génération des icônes personnalisées:`,
        error.message,
      );
      throw error;
    }
  }

  /**
   * Supprime toutes les icônes personnalisées d'une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   */
  async deleteCustomIcons(userId, signatureId) {
    try {
      logger.debug(
        `🗑️ Suppression des icônes personnalisées pour signature ${signatureId}`,
      );
      await CloudflareService.deleteCustomSocialIcons(userId, signatureId);
      logger.debug(`✅ Icônes personnalisées supprimées`);
    } catch (error) {
      console.error(
        `❌ Erreur lors de la suppression des icônes personnalisées:`,
        error.message,
      );
      throw error;
    }
  }

  /**
   * Retourne la couleur par défaut pour une plateforme
   * @param {string} platform - La plateforme
   * @returns {string} La couleur hexadécimale par défaut
   */
  getDefaultColor(platform) {
    const defaultColors = {
      facebook: "#1877F2",
      instagram: "#E4405F",
      linkedin: "#0077B5",
      x: "#000000",
    };
    return defaultColors[platform] || "#000000";
  }
}

export default new CustomSocialIconService();
