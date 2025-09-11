import express from 'express';
import { 
  authorizeDownload, 
  markDownloadCompleted, 
  getDownloadStats 
} from '../controllers/fileTransferAuthController.js';

const router = express.Router();

// Route d'autorisation de téléchargement
router.post('/:transferId/authorize', authorizeDownload);

// Route pour marquer un téléchargement comme terminé
router.post('/download-event/:downloadEventId/complete', markDownloadCompleted);

// Route pour obtenir les statistiques de téléchargement
router.get('/:transferId/stats', getDownloadStats);

export default router;
