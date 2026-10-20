// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

const plural = (n, one, many) => (n === 1 ? one : many);

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why an air-Q has no fresh value. */
export const REASONS = {
  refused: { en: 'password refused', fr: 'mot de passe refusé' },
  busy: { en: 'device busy (pause)', fr: 'appareil occupé (pause)' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
  invalid: { en: 'not an air-Q answer', fr: "réponse qui n'est pas celle d'un air-Q" },
  duplicate: {
    en: 'same air-Q as another address',
    fr: "même air-Q qu'une autre adresse",
  },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

const INVALID = {
  address: { en: 'address not understood', fr: 'adresse non comprise' },
  password: { en: 'password missing', fr: 'mot de passe manquant' },
  duplicate: { en: 'address entered twice', fr: 'adresse saisie deux fois' },
};

export const T = {
  notConfigured: {
    en: 'Enter the address (IP) and the password of an air-Q.',
    fr: "Saisissez l'adresse (IP) et le mot de passe d'un air-Q.",
  },
  invalidSlots: (invalid) => ({
    en: invalid.map((i) => `air-Q ${i.slot} ignored: ${INVALID[i.why].en}`).join('. '),
    fr: invalid.map((i) => `air-Q ${i.slot} ignoré : ${INVALID[i.why].fr}`).join('. '),
  }),
  refusedHelp: {
    en: 'A refused password stops the reads of that air-Q: check the password of the device (the one of the air-Q app); one new try every 6 hours until it changes.',
    fr: "Un mot de passe refusé arrête les lectures de cet air-Q : vérifiez le mot de passe de l'appareil (celui de l'application air-Q) ; un nouvel essai toutes les 6 heures jusqu'à ce qu'il change.",
  },
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, and what fails. */
  ok: ({ devices, interval, failing = [] }) => {
    let en = `${devices} air-Q, read every ${interval} min.`;
    let fr = `${devices} air-Q, ${plural(devices, 'lu', 'lus')} toutes les ${interval} min.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en, fr };
  },
};
