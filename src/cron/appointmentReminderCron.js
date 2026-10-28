/**
 * Rappels des rendez-vous pris sur les pages de réservation (voir
 * services/appointments/reminderService.js) : toutes les 5 minutes.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2) ; APPOINTMENT_REMINDERS_MODE=off coupe tout en urgence.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import {
  remindersMode,
  runAppointmentReminders,
} from "../services/appointments/reminderService.js";

export const APPOINTMENT_REMINDER_CRON = "*/5 * * * *";

let running = false;

export function startAppointmentReminderCron() {
  if (remindersMode() === "off") {
    logger.info(
      "[appointmentReminderCron] APPOINTMENT_REMINDERS_MODE=off : rappels de rendez-vous non planifiés",
    );
    return null;
  }
  const task = cron.schedule(
    APPOINTMENT_REMINDER_CRON,
    async () => {
      // Un passage peut durer (envois) : pas de chevauchement
      if (running) return;
      running = true;
      try {
        await runAppointmentReminders();
      } catch (error) {
        logger.error(`[appointmentReminderCron] erreur : ${error.message}`);
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    "[appointmentReminderCron] rappels de rendez-vous planifiés toutes les 5 minutes",
  );
  return task;
}
