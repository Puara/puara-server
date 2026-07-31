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
  tabPlay: { fr: 'Jouer', en: 'Play' },
  tabData: { fr: 'Données', en: 'Data' },
  dataHint: { fr: 'Ce que votre téléphone envoie', en: 'What your phone is sending' },
  dataOff: { fr: 'désactivé', en: 'off' },
  dataRate: { fr: 'Envois/s', en: 'Sends/s' },
  dataBattery: { fr: 'Batterie', en: 'Battery' },
  dataPaused: { fr: 'Rien n’est envoyé pour le moment', en: 'Nothing is being sent right now' },
  dataTouchPad: {
    fr: 'Touchez la zone ci-dessous — elle envoie comme l’onglet Jouer',
    en: 'Touch the area below — it sends just like the Play tab',
  },
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
