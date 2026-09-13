import mongoose from "mongoose";
import ForecastScenario from "../models/ForecastScenario.js";

// Un scénario est un CALQUE posé sur les données de Base : il ne copie rien,
// il enregistre seulement ce qui diffère (récurrences masquées/réactivées,
// saisies de Base masquées, occurrences supprimées pour un mois) plus ses
// propres saisies manuelles (ManualCashflowEntry.scenarioId). Tout ce qui est
// fait dans un scénario reste dans ce scénario ; Base n'est jamais touchée.
//
// buildScenarioOverlay() renvoie les prédicats à appliquer lors des
// projections ; sans scénario (Base) ils se replient sur les champs des
// entités elles-mêmes. Exporté pour les tests.

const idOf = (doc) => String(doc?._id ?? doc?.id ?? doc);

export const buildScenarioOverlay = (scenario) => {
  if (!scenario) {
    return {
      scenario: null,
      scenarioId: null,
      isScenario: false,
      overriddenRecurrenceIds: [],
      hasRecurrenceOverride: () => false,
      isRecurrenceMuted: (rec) => Boolean(rec.isMuted),
      isRecurrenceProjected: (rec) => Boolean(rec.isActive) && !rec.isMuted,
      isManualEntryHidden: () => false,
      isOccurrenceExcluded: () => false,
      // Filtre Mongo des saisies manuelles visibles : Base uniquement.
      manualEntryFilter: () => ({ scenarioId: null }),
    };
  }

  const overrides = new Map(
    (scenario.recurrenceOverrides || []).map((o) => [
      String(o.recurrenceId),
      Boolean(o.isMuted),
    ]),
  );
  const hiddenManual = new Set(
    (scenario.hiddenManualEntryIds || []).map((id) => String(id)),
  );
  const excluded = new Set(
    (scenario.excludedOccurrences || []).map(
      (o) => `${o.kind}::${String(o.entityId)}::${o.month}`,
    ),
  );

  const isMuted = (rec) => {
    const id = idOf(rec);
    return overrides.has(id) ? overrides.get(id) : Boolean(rec.isMuted);
  };

  return {
    scenario,
    scenarioId: String(scenario._id),
    isScenario: true,
    overriddenRecurrenceIds: [...overrides.keys()].map(
      (id) => new mongoose.Types.ObjectId(id),
    ),
    hasRecurrenceOverride: (rec) => overrides.has(idOf(rec)),
    isRecurrenceMuted: isMuted,
    // Une récurrence masquée en Base a isActive=false : si le scénario la
    // réactive, on la projette dès que sa série est encore valide (>= 2
    // occurrences, même plancher que muteDetectedRecurrence).
    isRecurrenceProjected: (rec) => {
      if (isMuted(rec)) return false;
      const id = idOf(rec);
      if (overrides.has(id) && overrides.get(id) === false) {
        return Boolean(rec.isActive) || (rec.consecutiveMonths || 0) >= 2;
      }
      return Boolean(rec.isActive);
    },
    isManualEntryHidden: (entry) => hiddenManual.has(idOf(entry)),
    isOccurrenceExcluded: (kind, entityId, month) =>
      excluded.has(`${kind}::${String(entityId)}::${month}`),
    // Saisies de Base + saisies propres au scénario.
    manualEntryFilter: () => ({
      $or: [{ scenarioId: null }, { scenarioId: scenario._id }],
    }),
  };
};

// Charge le scénario (dans le workspace) et construit le calque. Un id
// inconnu ou d'un autre workspace retombe sur Base.
export const loadScenarioOverlay = async (scenarioId, workspaceObjectId) => {
  if (!scenarioId || !mongoose.Types.ObjectId.isValid(scenarioId)) {
    return buildScenarioOverlay(null);
  }
  const scenario = await ForecastScenario.findOne({
    _id: scenarioId,
    workspaceId: workspaceObjectId,
  }).lean();
  return buildScenarioOverlay(scenario);
};

// Filtre Mongo des récurrences candidates à la projection : les actives non
// masquées (Base) + celles que le scénario surcharge (pour pouvoir réactiver
// une récurrence masquée en Base).
export const projectableRecurrenceFilter = (workspaceObjectId, overlay) => {
  const base = {
    workspaceId: workspaceObjectId,
    isActive: true,
    isMuted: false,
  };
  if (!overlay?.overriddenRecurrenceIds?.length) return base;
  return {
    workspaceId: workspaceObjectId,
    $or: [
      { isActive: true, isMuted: false },
      { _id: { $in: overlay.overriddenRecurrenceIds } },
    ],
  };
};
