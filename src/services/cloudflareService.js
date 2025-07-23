import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';

// Charger les variables d'environnement
dotenv.config();

// Configuration du client S3 pour Cloudflare R2
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.AWS_S3_API_URL,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Générer une clé unique pour le stockage
function generateFileKey(userId, fileType, originalName) {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const extension = path.extname(originalName).toLowerCase();
  return `signatures/${userId}/${fileType}/${timestamp}-${randomString}${extension}`;
}

// Téléverser un fichier vers Cloudflare R2
export async function uploadFile(file, userId, fileType) {
  try {
    const key = generateFileKey(userId, fileType, file.originalname);
    const params = {
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await s3Client.send(new PutObjectCommand(params));
    
    // Retourner la clé et l'URL publique si configurée
    return {
      key,
      url: process.env.AWS_R2_PUBLIC_URL 
        ? `${process.env.AWS_R2_PUBLIC_URL}/${key}` 
        : await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET_NAME,
          Key: key,
        }), { expiresIn: 60 * 60 * 24 }), // 24h d'expiration pour les URLs signées
    };
  } catch (error) {
    console.error('Erreur lors du téléversement du fichier:', error);
    throw new Error('Échec du téléversement du fichier');
  }
}

// Supprimer un fichier de Cloudflare R2
export async function deleteFile(key) {
  try {
    const params = {
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: key,
    };

    await s3Client.send(new DeleteObjectCommand(params));
    return true;
  } catch (error) {
    console.error('Erreur lors de la suppression du fichier:', error);
    throw new Error('Échec de la suppression du fichier');
  }
}

// Obtenir l'URL d'un fichier
export async function getFileUrl(key) {
  try {
    // Si une URL publique est configurée, l'utiliser
    if (process.env.AWS_R2_PUBLIC_URL) {
      return `${process.env.AWS_R2_PUBLIC_URL}/${key}`;
    }
    
    // Sinon, générer une URL signée
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: key,
    });
    
    return await getSignedUrl(s3Client, command, { expiresIn: 60 * 60 * 24 }); // 24h d'expiration
  } catch (error) {
    console.error('Erreur lors de la génération de l\'URL du fichier:', error);
    throw new Error('Échec de la génération de l\'URL du fichier');
  }
}
