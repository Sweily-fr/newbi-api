// Ce qu'un visiteur d'un tableau public reçoit d'une tâche (page
// /public/kanban/<jeton>, réponse d'un commentaire, temps réel).
//
// - Adresses e-mail : seulement la sienne (la page reconnaît ainsi ses
//   propres commentaires) ; jamais celles des autres visiteurs ni des
//   membres de l'espace.
// - Ni taux horaire, ni identifiants internes (créateur de la tâche,
//   personne qui a lancé le minuteur) : le nom du créateur est donné à la
//   place de son identifiant.
// - Permissions du lien appliquées : tâches, commentaires, pièces jointes,
//   membres assignés, dates.

const allowed = (permissions, flag) => permissions?.[flag] !== false;

const sameEmail = (a, b) =>
  Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

export function visitorTaskView(task, { viewerEmail, permissions } = {}) {
  if (!task) return task;
  const attachments = allowed(permissions, "canViewAttachments");
  const assignees = allowed(permissions, "canViewAssignees");
  const dates = allowed(permissions, "canViewDueDates");
  const comments = allowed(permissions, "canViewComments")
    ? (task.comments || []).map((comment) => ({
        ...comment,
        userEmail: sameEmail(comment.userEmail, viewerEmail)
          ? comment.userEmail
          : null,
        images: attachments ? comment.images || [] : [],
      }))
    : [];
  const timeTracking = task.timeTracking
    ? {
        ...task.timeTracking,
        hourlyRate: null,
        startedBy: task.timeTracking.startedBy
          ? {
              ...task.timeTracking.startedBy,
              userId: null,
              ...(assignees ? {} : { userName: null, userImage: null }),
            }
          : null,
      }
    : null;
  return {
    ...task,
    comments,
    images: attachments ? task.images || [] : [],
    assignedMembers: assignees ? task.assignedMembers || [] : [],
    startDate: dates ? task.startDate : null,
    dueDate: dates ? task.dueDate : null,
    timeTracking,
    userId: null,
    createdByName: assignees ? task.createdByName || null : null,
  };
}

/** Tâches du tableau pour un visiteur (aucune si le lien ne les montre pas). */
export function visitorTasksView(tasks, options = {}) {
  if (!allowed(options.permissions, "canViewTasks")) return [];
  return (tasks || []).map((task) => visitorTaskView(task, options));
}

/** Membres affichés sur la page publique (aucun si le lien les masque). */
export function visitorMembersView(members, { permissions } = {}) {
  return allowed(permissions, "canViewAssignees") ? members || [] : [];
}
