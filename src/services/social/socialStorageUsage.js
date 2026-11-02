/**
 * Médias des posts réseaux sociaux dans le compteur de stockage de l'espace
 * (bucket SOCIAL_MEDIA_BUCKET). Ajouté au recalcul par un collecteur : le
 * stockage ne dépend pas de ce module, qui s'inscrit lui-même.
 */
import mongoose from "mongoose";
import SocialPostMedia from "../../models/SocialPostMedia.js";
import { registerStorageCollector } from "../storage/storageUsageCompute.js";

async function collectSocialMedia({ workspaceId }) {
  const values = [String(workspaceId)];
  if (mongoose.Types.ObjectId.isValid(String(workspaceId))) {
    values.push(new mongoose.Types.ObjectId(String(workspaceId)));
  }
  const medias = await SocialPostMedia.collection
    .find(
      {
        workspaceId: { $in: values },
        provider: "newbi",
        status: { $ne: "failed" },
        key: { $nin: [null, ""] },
      },
      { projection: { key: 1, size: 1, thumbnailKey: 1, createdBy: 1 } },
    )
    .toArray();
  const bucket = process.env.SOCIAL_MEDIA_BUCKET || null;
  const entries = [];
  for (const media of medias) {
    const userId = media.createdBy ? String(media.createdBy) : null;
    entries.push({ key: media.key, bucket, size: media.size, category: "social", userId });
    if (media.thumbnailKey) {
      entries.push({ key: media.thumbnailKey, bucket, category: "social", userId });
    }
  }
  return entries;
}

registerStorageCollector("social", collectSocialMedia);

export default collectSocialMedia;
