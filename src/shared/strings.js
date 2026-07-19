// Bilingual UI strings, FR first (SAT audience).
export const strings = {
  start: { fr: 'Commencer', en: 'Start' },
  connecting: { fr: 'Connexion…', en: 'Connecting…' },
  reconnecting: { fr: 'Reconnexion…', en: 'Reconnecting…' },
  waiting: { fr: 'Le spectacle n’a pas encore commencé', en: 'The show hasn’t started yet' },
  active: { fr: 'Vous faites partie du spectacle', en: 'You are part of the show' },
  touchHint: { fr: 'Touchez l’écran', en: 'Touch the screen' },
  over: { fr: 'Merci ! Le spectacle est terminé', en: 'Thanks! The show is over' },
  zone: { fr: 'Zone', en: 'Zone' },
};

export function t(key, lang = 'fr') {
  const entry = strings[key];
  if (!entry) {
    return key;
  }
  return `${entry.fr}${lang === 'both' ? ` / ${entry.en}` : ''}`;
}

// bilingual label "FR / EN"
export function tt(key) {
  const entry = strings[key];
  return entry ? `${entry.fr} / ${entry.en}` : key;
}
