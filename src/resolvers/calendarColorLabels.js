import CalendarColorLabel from '../models/CalendarColorLabel.js';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';

const NAMED_TO_HEX = {
  sky: '#38BDF8', amber: '#FBBF24', violet: '#8B5CF6', rose: '#FB7185',
  emerald: '#34D399', orange: '#FB923C', blue: '#3B82F6', green: '#22C55E',
  red: '#EF4444', purple: '#A855F7', pink: '#EC4899', yellow: '#EAB308',
};

const normalizeColor = (color) => NAMED_TO_HEX[color] || color;

const DEFAULT_LABELS = [
  { color: '#1D1D1B', label: 'Noir' },
  { color: '#EAB308', label: 'Jaune' },
  { color: '#22C55E', label: 'Vert' },
  { color: '#3B82F6', label: 'Bleu' },
  { color: '#EF4444', label: 'Rouge' },
  { color: '#8B5CF6', label: 'Violet' },
];

const calendarColorLabelsResolvers = {
  Query: {
    getCalendarColorLabels: withWorkspace(async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;

      const doc = await CalendarColorLabel.findOne({ workspaceId: finalWorkspaceId });

      const rawLabels = doc ? doc.labels : DEFAULT_LABELS;
      const labels = rawLabels.map(l => ({ color: normalizeColor(l.color), label: l.label }));

      return {
        success: true,
        message: 'Étiquettes récupérées avec succès',
        labels,
      };
    }),
  },

  Mutation: {
    updateCalendarColorLabels: withWorkspace(async (_, { labels, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;

      const normalizedLabels = labels.map(l => ({ color: normalizeColor(l.color), label: l.label }));

      const doc = await CalendarColorLabel.findOneAndUpdate(
        { workspaceId: finalWorkspaceId },
        { labels: normalizedLabels, updatedAt: Date.now() },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );

      return {
        success: true,
        message: 'Étiquettes mises à jour avec succès',
        labels: doc.labels.map(l => ({ color: normalizeColor(l.color), label: l.label })),
      };
    }),
  },
};

export default calendarColorLabelsResolvers;
