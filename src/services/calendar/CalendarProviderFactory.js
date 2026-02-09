import GoogleCalendarProvider from './providers/GoogleCalendarProvider.js';
import MicrosoftCalendarProvider from './providers/MicrosoftCalendarProvider.js';
import AppleCalendarProvider from './providers/AppleCalendarProvider.js';

const providers = {};

/**
 * Factory to get calendar provider instances (singleton per provider)
 */
export function getCalendarProvider(providerName) {
  if (providers[providerName]) {
    return providers[providerName];
  }

  switch (providerName) {
    case 'google':
      providers[providerName] = new GoogleCalendarProvider();
      break;
    case 'microsoft':
      providers[providerName] = new MicrosoftCalendarProvider();
      break;
    case 'apple':
      providers[providerName] = new AppleCalendarProvider();
      break;
    default:
      throw new Error(`Unknown calendar provider: ${providerName}`);
  }

  return providers[providerName];
}

export const SUPPORTED_PROVIDERS = ['google', 'microsoft', 'apple'];
