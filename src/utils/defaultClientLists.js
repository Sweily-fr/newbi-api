/**
 * Listes de clients par défaut pour les commerciaux
 */
export const DEFAULT_CLIENT_LISTS = [
  {
    name: 'Prospects',
    description: 'Clients potentiels à contacter',
    color: '#3b82f6',
    icon: 'Target',
    isDefault: true
  },
  {
    name: 'Clients actifs',
    description: 'Clients actuellement en contrat',
    color: '#10b981',
    icon: 'CheckCircle',
    isDefault: true
  },
  {
    name: 'Clients inactifs',
    description: 'Clients sans activité récente',
    color: '#ef4444',
    icon: 'AlertCircle',
    isDefault: true
  },
  {
    name: 'VIP',
    description: 'Clients prioritaires et importants',
    color: '#f59e0b',
    icon: 'Star',
    isDefault: true
  },
  {
    name: 'À relancer',
    description: 'Clients à relancer ou à suivre',
    color: '#8b5cf6',
    icon: 'RefreshCw',
    isDefault: true
  }
];

/**
 * Crée les listes par défaut pour un workspace
 */
export async function createDefaultClientLists(ClientList, workspaceId, userId) {
  try {
    const existingLists = await ClientList.countDocuments({ workspaceId, isDefault: true });
    
    if (existingLists > 0) {
      console.log(`Les listes par défaut existent déjà pour le workspace ${workspaceId}`);
      return;
    }

    const listsToCreate = DEFAULT_CLIENT_LISTS.map(list => ({
      ...list,
      workspaceId,
      createdBy: userId,
      clients: []
    }));

    await ClientList.insertMany(listsToCreate);
    console.log(`✅ ${listsToCreate.length} listes par défaut créées pour le workspace ${workspaceId}`);
  } catch (error) {
    console.error('Erreur lors de la création des listes par défaut:', error);
    throw error;
  }
}
