// Mapping des noms de couleurs courants (Microsoft Graph, Google) — constante module
const COLOR_NAME_MAP = {
  'lightblue': 'sky', 'blue': 'blue', 'darkblue': 'blue',
  'lightgreen': 'emerald', 'green': 'green', 'darkgreen': 'green',
  'lightyellow': 'yellow', 'yellow': 'yellow',
  'lightorange': 'orange', 'orange': 'orange',
  'lightred': 'rose', 'red': 'red', 'darkred': 'red',
  'lightpink': 'pink', 'pink': 'pink',
  'lightpurple': 'violet', 'purple': 'purple', 'darkpurple': 'purple',
  'lightteal': 'emerald', 'teal': 'emerald', 'darkteal': 'emerald',
};

/**
 * Convert a hex color or color name to the closest Newbi event color enum value
 */
function mapExternalColorToNewbi(externalColor, defaultColor) {
  if (!externalColor) return defaultColor;

  const lowerColor = externalColor.toLowerCase().trim();
  if (lowerColor === 'auto') return defaultColor;
  if (COLOR_NAME_MAP[lowerColor]) return COLOR_NAME_MAP[lowerColor];

  // Si c'est un hex, mapper par teinte (hue)
  if (lowerColor.startsWith('#') && (lowerColor.length === 7 || lowerColor.length === 4)) {
    try {
      let r, g, b;
      if (lowerColor.length === 4) {
        r = parseInt(lowerColor[1] + lowerColor[1], 16);
        g = parseInt(lowerColor[2] + lowerColor[2], 16);
        b = parseInt(lowerColor[3] + lowerColor[3], 16);
      } else {
        r = parseInt(lowerColor.slice(1, 3), 16);
        g = parseInt(lowerColor.slice(3, 5), 16);
        b = parseInt(lowerColor.slice(5, 7), 16);
      }

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 510; // lightness 0-1

      if (max - min < 30) {
        // Achromatic (gris)
        return defaultColor;
      }

      let h;
      const d = max - min;
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      else if (max === g) h = ((b - r) / d + 2) * 60;
      else h = ((r - g) / d + 4) * 60;

      // Mapper hue → Newbi color
      if (h < 15 || h >= 345) return 'red';
      if (h < 40) return 'orange';
      if (h < 65) return 'amber';
      if (h < 80) return 'yellow';
      if (h < 160) return 'emerald';
      if (h < 200) return 'sky';
      if (h < 250) return 'blue';
      if (h < 290) return 'violet';
      if (h < 330) return 'rose';
      return 'pink';
    } catch {
      return defaultColor;
    }
  }

  return defaultColor;
}

/**
 * Map a Google Calendar event to Newbi Event format
 */
export function mapGoogleEventToNewbi(googleEvent, connectionId, userId, calendarColor) {
  const start = googleEvent.start?.dateTime
    ? new Date(googleEvent.start.dateTime)
    : new Date(googleEvent.start?.date);
  const end = googleEvent.end?.dateTime
    ? new Date(googleEvent.end.dateTime)
    : new Date(googleEvent.end?.date);
  const allDay = !googleEvent.start?.dateTime;

  return {
    title: googleEvent.summary || '(Sans titre)',
    description: googleEvent.description || '',
    start,
    end,
    allDay,
    location: googleEvent.location || '',
    color: mapExternalColorToNewbi(calendarColor, 'blue'),
    type: 'EXTERNAL',
    source: 'google',
    visibility: 'private',
    isReadOnly: true,
    externalEventId: googleEvent.id,
    calendarConnectionId: connectionId,
    userId
  };
}

/**
 * Map a Microsoft Graph event to Newbi Event format
 */
export function mapMicrosoftEventToNewbi(msEvent, connectionId, userId, calendarColor) {
  // Microsoft Graph retourne les heures dans le timezone spécifié par le calendrier
  // On utilise le timeZone fourni par l'API pour une conversion correcte
  const startTz = msEvent.start?.timeZone;
  const endTz = msEvent.end?.timeZone;

  let start, end;
  if (startTz === 'UTC' || !startTz) {
    start = new Date(msEvent.start?.dateTime + 'Z');
  } else {
    // Construire un format ISO avec le timezone pour que Date le parse correctement
    try {
      const startStr = msEvent.start?.dateTime;
      start = new Date(new Date(startStr).toLocaleString('en-US', { timeZone: startTz }));
      // Fallback: si le parsing échoue, traiter comme UTC
      if (isNaN(start.getTime())) start = new Date(startStr + 'Z');
    } catch {
      start = new Date(msEvent.start?.dateTime + 'Z');
    }
  }

  if (endTz === 'UTC' || !endTz) {
    end = new Date(msEvent.end?.dateTime + 'Z');
  } else {
    try {
      const endStr = msEvent.end?.dateTime;
      end = new Date(new Date(endStr).toLocaleString('en-US', { timeZone: endTz }));
      if (isNaN(end.getTime())) end = new Date(endStr + 'Z');
    } catch {
      end = new Date(msEvent.end?.dateTime + 'Z');
    }
  }
  const allDay = msEvent.isAllDay || false;

  return {
    title: msEvent.subject || '(Sans titre)',
    description: msEvent.bodyPreview || '',
    start,
    end,
    allDay,
    location: msEvent.location?.displayName || '',
    color: mapExternalColorToNewbi(calendarColor, 'violet'),
    type: 'EXTERNAL',
    source: 'microsoft',
    visibility: 'private',
    isReadOnly: true,
    externalEventId: msEvent.id,
    calendarConnectionId: connectionId,
    userId
  };
}

/**
 * Map an Apple CalDAV event to Newbi Event format
 */
export function mapAppleEventToNewbi(calDavEvent, connectionId, userId, calendarColor) {
  const vevent = calDavEvent.data || calDavEvent;

  return {
    title: vevent.summary || vevent.title || '(Sans titre)',
    description: vevent.description || '',
    start: new Date(vevent.startDate || vevent.start),
    end: new Date(vevent.endDate || vevent.end),
    allDay: vevent.allDay || false,
    location: vevent.location || '',
    color: mapExternalColorToNewbi(calendarColor, 'rose'),
    type: 'EXTERNAL',
    source: 'apple',
    visibility: 'private',
    isReadOnly: true,
    externalEventId: vevent.uid || calDavEvent.url,
    calendarConnectionId: connectionId,
    userId
  };
}

/**
 * Map a Newbi event to Google Calendar event format
 */
export function mapNewbiToGoogleEvent(newbiEvent) {
  const event = {
    summary: newbiEvent.title,
    description: newbiEvent.description || '',
    location: newbiEvent.location || ''
  };

  if (newbiEvent.allDay) {
    const startDate = new Date(newbiEvent.start).toISOString().split('T')[0];
    const endDate = new Date(newbiEvent.end).toISOString().split('T')[0];
    event.start = { date: startDate };
    event.end = { date: endDate };
  } else {
    event.start = { dateTime: new Date(newbiEvent.start).toISOString(), timeZone: 'Europe/Paris' };
    event.end = { dateTime: new Date(newbiEvent.end).toISOString(), timeZone: 'Europe/Paris' };
  }

  return event;
}

/**
 * Map a Newbi event to Microsoft Graph event format
 */
export function mapNewbiToMicrosoftEvent(newbiEvent) {
  return {
    subject: newbiEvent.title,
    body: {
      contentType: 'Text',
      content: newbiEvent.description || ''
    },
    start: {
      dateTime: new Date(newbiEvent.start).toISOString().replace('Z', ''),
      timeZone: 'Europe/Paris'
    },
    end: {
      dateTime: new Date(newbiEvent.end).toISOString().replace('Z', ''),
      timeZone: 'Europe/Paris'
    },
    location: {
      displayName: newbiEvent.location || ''
    },
    isAllDay: newbiEvent.allDay || false
  };
}

/**
 * Map a Newbi event to iCalendar (ICS) format for Apple CalDAV
 */
export function mapNewbiToICalEvent(newbiEvent) {
  const uid = `newbi-${newbiEvent._id || newbiEvent.id}@newbi.fr`;
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  let dtStart, dtEnd;
  if (newbiEvent.allDay) {
    dtStart = `DTSTART;VALUE=DATE:${formatDateValue(newbiEvent.start)}`;
    dtEnd = `DTEND;VALUE=DATE:${formatDateValue(newbiEvent.end)}`;
  } else {
    dtStart = `DTSTART:${formatDateTimeValue(newbiEvent.start)}`;
    dtEnd = `DTEND:${formatDateTimeValue(newbiEvent.end)}`;
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Newbi//Calendar//FR',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeICalText(newbiEvent.title)}`,
    newbiEvent.description ? `DESCRIPTION:${escapeICalText(newbiEvent.description)}` : '',
    newbiEvent.location ? `LOCATION:${escapeICalText(newbiEvent.location)}` : '',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

function formatDateValue(date) {
  const d = new Date(date);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

function formatDateTimeValue(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeICalText(text) {
  if (!text) return '';
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
