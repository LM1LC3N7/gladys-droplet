// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a free text of the Droplet: only our own words, error codes, numbers
// we checked, the device id (letters, digits, `_`, `-`) and the fingerprint
// of a certificate met. Never the pairing code.
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  // Rounded first: 59.99 s is told "1 min", never "60 s".
  if (Math.round(ms / 1000) >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** A status is bounded: Gladys shows it in one block. */
const MAX_STATUS = 1500;
const bound = (text) => (text.length > MAX_STATUS ? `${text.slice(0, MAX_STATUS - 1)}…` : text);

/** Litres, with the US gallons in brackets (the Droplet app counts in gallons). */
const litres = (l, lang) => {
  const gal = l / 3.785411784;
  const r = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  return lang === 'en' ? `${r(l)} L (${r(gal)} US gal)` : `${r(l)} L (${r(gal)} gal US)`;
};

/** Our words for an error code of src/droplet/client.js. */
const REASON = {
  timeout: { en: 'no answer', fr: 'pas de réponse' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  closed: { en: 'connection closed by the Droplet', fr: 'connexion fermée par le Droplet' },
  early: {
    en: 'connection closed by the Droplet at once, before any data (a wrong pairing code on an older firmware?)',
    fr: 'connexion fermée aussitôt par le Droplet, avant toute donnée (code d’appairage erroné sur un ancien firmware ?)',
  },
  http: { en: 'HTTP answer instead of the WebSocket', fr: 'réponse HTTP au lieu du WebSocket' },
  server: { en: 'error of the Droplet', fr: 'erreur du Droplet' },
  rate_limited: { en: 'too many requests', fr: 'trop de requêtes' },
  refused: { en: 'pairing code refused', fr: 'code d’appairage refusé' },
  bad_answer: {
    en: 'not the WebSocket of a Droplet (is it the right address?)',
    fr: 'ce n’est pas le WebSocket d’un Droplet (est-ce la bonne adresse ?)',
  },
  tls: { en: 'TLS handshake refused', fr: 'négociation TLS refusée' },
  certificate: {
    en: 'not the pinned certificate',
    fr: 'ce n’est pas le certificat épinglé',
  },
  certificate_typed: {
    en: 'not the certificate typed',
    fr: 'ce n’est pas le certificat saisi',
  },
  pin_unavailable: {
    en: '/data cannot be written: the certificate cannot be pinned, nothing sent',
    fr: '/data ne peut pas être écrit : le certificat ne peut pas être épinglé, rien envoyé',
  },
  pin_unreadable: {
    en: '/data cannot be read: no certificate learned, nothing sent (or type its fingerprint)',
    fr: '/data ne peut pas être lu : aucun certificat appris, rien envoyé (ou saisissez son empreinte)',
  },
  late: { en: 'configuration changed', fr: 'configuration changée' },
};

export function reason(err) {
  let key = err?.code;
  if (err?.code === 'pin_unavailable' && err.reason === 'unreadable') key = 'pin_unreadable';
  if (err?.early) key = 'early';
  else if (err?.closed) key = 'closed';
  const text = REASON[key] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
  const status =
    (err?.code === 'http' || err?.code === 'server') && Number.isInteger(err.status)
      ? ` ${err.status}`
      : '';
  return { en: `${text.en}${status}`, fr: `${text.fr}${status}` };
}

const join = (lang, first, notes) => [first[lang], ...notes.map((n) => n[lang])].join(' ');
const withNotes = (first, notes) => ({
  en: bound(join('en', first, notes)),
  fr: bound(join('fr', first, notes)),
});

/** A held volume in words: which Droplet, how much, in how many reports. */
const heldText = (lang, h) =>
  lang === 'en'
    ? `Droplet ${h.id}: ${litres(h.ml / 1000, 'en')} in ${h.count} report(s)`
    : `Droplet ${h.id} : ${litres(h.ml / 1000, 'fr')} en ${h.count} relevé(s)`;
const helds = (lang, list) => list.map((h) => heldText(lang, h)).join('; ');

export const T = {
  incomplete: {
    en: 'Enter the address of your Droplet (its IP address on your network, e.g. 192.168.1.30) and its pairing code (Droplet app).',
    fr: 'Saisissez l’adresse de votre Droplet (son adresse IP sur votre réseau, ex. 192.168.1.30) et son code d’appairage (application Droplet).',
  },
  badAddress: {
    en: 'The Droplet address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.30).',
    fr: 'L’adresse du Droplet n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.30).',
  },
  badAddressHttp: {
    en: 'The Droplet answers over TLS only: enter its address without "http://" nor "ws://".',
    fr: 'Le Droplet ne répond qu’en TLS : saisissez son adresse sans « http:// » ni « ws:// ».',
  },
  badCode: {
    en: 'The pairing code holds a space, a line break or a character that is not plain ASCII, or is too long: type it again as the Droplet app shows it.',
    fr: 'Le code d’appairage contient une espace, un retour à la ligne ou un caractère hors ASCII simple, ou il est trop long : saisissez-le à nouveau tel que l’application Droplet l’affiche.',
  },
  badFingerprint: {
    en: 'The certificate fingerprint is not valid: 64 hexadecimal digits (with or without colons), as the status showed it.',
    fr: 'L’empreinte du certificat n’est pas valide : 64 chiffres hexadécimaux (avec ou sans deux-points), tels que le statut l’a affichée.',
  },
  configUnread: (wait) => ({
    en: `The configuration could not be read from Gladys: tried again in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  badgeHeld: {
    en: 'A volume report is held back (see the integration status).',
    fr: 'Un relevé de volume est retenu (voir le statut de l’intégration).',
  },
  refused: (address, notes) =>
    withNotes(
      {
        en: `The Droplet at ${address} refuses the pairing code: nothing is tried until the code is saved again (copy it from the Droplet app) or the "Test the connection" button gets a connection.`,
        fr: `Le Droplet à ${address} refuse le code d’appairage : plus rien n’est tenté tant que le code n’est pas enregistré à nouveau (copiez-le depuis l’application Droplet) ou que le bouton « Tester la connexion » n’obtient pas de connexion.`,
      },
      notes,
    ),
  paused: (address, pause, left, notes) =>
    withNotes(
      {
        en: `The Droplet at ${address} answered ${pause.code === 'rate_limited' ? '"too many requests"' : `an error${pause.status ? ` ${pause.status}` : ''}`}: connection paused for ${delay(left).en}.`,
        fr: `Le Droplet à ${address} a répondu ${pause.code === 'rate_limited' ? '« trop de requêtes »' : `une erreur${pause.status ? ` ${pause.status}` : ''}`} : connexion en pause pendant ${delay(left).fr}.`,
      },
      notes,
    ),
  certificateChanged: (address, seen, typed, notes) =>
    withNotes(
      typed
        ? {
            en: `The certificate of the Droplet at ${address} is not the fingerprint typed: nothing sent. Certificate met: ${seen}.`,
            fr: `Le certificat du Droplet à ${address} n’est pas l’empreinte saisie : rien envoyé. Certificat rencontré : ${seen}.`,
          }
        : {
            en: `The certificate of the Droplet at ${address} is not the one met at the first connection: nothing sent (the pairing code never goes to an unknown certificate). If you replaced or reset the Droplet, copy this fingerprint into the "Certificate fingerprint" field and save: ${seen}.`,
            fr: `Le certificat du Droplet à ${address} n’est pas celui de la première connexion : rien envoyé (le code d’appairage ne part jamais vers un certificat inconnu). Si vous avez remplacé ou réinitialisé le Droplet, copiez cette empreinte dans le champ « Empreinte du certificat » et enregistrez : ${seen}.`,
          },
      notes,
    ),
  unreachable: (address, err, wait, notes) =>
    withNotes(
      {
        en: `No connection to the Droplet at ${address} (${reason(err).en}): next try in ${delay(wait).en}.`,
        fr: `Pas de connexion au Droplet à ${address} (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
      },
      notes,
    ),
  connecting: (address, notes) =>
    withNotes(
      {
        en: `Connecting to the Droplet at ${address}.`,
        fr: `Connexion au Droplet à ${address}.`,
      },
      notes,
    ),
  waitingData: (address, notes) =>
    withNotes(
      {
        en: `Connected to ${address}, waiting for the first message of the Droplet.`,
        fr: `Connecté à ${address}, en attente du premier message du Droplet.`,
      },
      notes,
    ),
  waitingId: (address, long, notes) =>
    withNotes(
      long
        ? {
            en: `The Droplet at ${address} sends values but has not given its device id for a minute: nothing is published until it does (its volumes are kept for it).`,
            fr: `Le Droplet à ${address} envoie des valeurs mais n’a pas donné son identifiant depuis une minute : rien n’est publié tant qu’il ne l’a pas fait (ses volumes lui sont gardés).`,
          }
        : {
            en: `Connected to the Droplet at ${address}, waiting for its device id.`,
            fr: `Connecté au Droplet à ${address}, en attente de son identifiant.`,
          },
      notes,
    ),
  ok: (address, id, notes) =>
    withNotes(
      {
        en: `Connected to Droplet ${id} at ${address}.`,
        fr: `Connecté au Droplet ${id} à ${address}.`,
      },
      notes,
    ),
  notes: {
    storeUnreadable: (code) => ({
      en: `/data cannot be read (${code}): the water index is not published (its volumes are kept in memory) and no certificate is learned, until it reads again.`,
      fr: `/data ne peut pas être lu (${code}) : l’index d’eau n’est pas publié (ses volumes sont gardés en mémoire) et aucun certificat n’est appris, jusqu’à ce qu’il se lise à nouveau.`,
    }),
    saveFailed: {
      en: '/data cannot be written: the water index is held back.',
      fr: '/data ne peut pas être écrit : l’index d’eau est retenu.',
    },
    held: (list) => ({
      en: `Volume held back, never counted without you (too large for the time since the previous report): ${helds('en', list)}. If it is right, click "Accept the held volume" twice.`,
      fr: `Volume retenu, jamais compté sans vous (trop grand pour le temps écoulé depuis le relevé précédent) : ${helds('fr', list)}. Si c’est juste, cliquez deux fois sur « Accepter le volume retenu ».`,
    }),
    shortfall: (l) => ({
      en: `The volumes reported sit ${litres(l, 'en')} below the water index (negative reports): the index waits until they climb back, it never goes down.`,
      fr: `Les volumes relevés sont ${litres(l, 'fr')} sous l’index d’eau (relevés négatifs) : l’index attend qu’ils remontent, il ne baisse jamais.`,
    }),
    ignored: (n) => ({
      en: `${n} negative volume report(s) too large ignored.`,
      fr: `${n} relevé(s) de volume négatif(s) trop grand(s) ignoré(s).`,
    }),
    invalidId: {
      en: 'The Droplet gave a device id that cannot be used (characters other than letters, digits, "_" and "-"): nothing published.',
      fr: 'Le Droplet a donné un identifiant inutilisable (caractères autres que lettres, chiffres, « _ » et « - ») : rien de publié.',
    },
    rejected: (n) => ({
      en: `${n} value(s) of the Droplet unreadable (not a number, out of bounds): ignored.`,
      fr: `${n} valeur(s) du Droplet illisible(s) (pas un nombre, hors bornes) : ignorée(s).`,
    }),
    odd: (n) => ({
      en: `${n} message(s) that are not Droplet messages: ignored.`,
      fr: `${n} message(s) qui ne sont pas des messages du Droplet : ignoré(s).`,
    }),
    noDevice: {
      en: 'Create the Droplet in the "Discover" tab.',
      fr: 'Créez le Droplet dans l’onglet « Découverte ».',
    },
  },
  accept: {
    nothing: {
      en: 'No volume is held back: nothing to accept.',
      fr: 'Aucun volume n’est retenu : rien à accepter.',
    },
    confirm: (list, within) => ({
      en: bound(
        `Held back: ${helds('en', list)}. Click again within ${delay(within).en} (after 3 s) to add exactly this to the water index.`,
      ),
      fr: bound(
        `Retenu : ${helds('fr', list)}. Cliquez à nouveau dans les ${delay(within).fr} (après 3 s) pour ajouter exactement cela à l’index d’eau.`,
      ),
    }),
    done: (accepted, changed) => {
      const text = (lang) => {
        const parts = [];
        if (accepted.length > 0) {
          parts.push(
            lang === 'en'
              ? `Added to the water index, published within a minute: ${helds('en', accepted)}.`
              : `Ajouté à l’index d’eau, publié d’ici une minute : ${helds('fr', accepted)}.`,
          );
        }
        if (changed.length > 0) {
          parts.push(
            lang === 'en'
              ? `No longer held as listed, not accepted: ${helds('en', changed)}.`
              : `Plus retenu tel que listé, non accepté : ${helds('fr', changed)}.`,
          );
        }
        return bound(parts.join(' '));
      };
      return { en: text('en'), fr: text('fr') };
    },
  },
  test: {
    slow: {
      en: 'The Droplet is slow to answer: the result will be in the integration status.',
      fr: 'Le Droplet tarde à répondre : le résultat sera dans le statut de l’intégration.',
    },
    connecting: {
      en: 'A connection to the Droplet is under way: the result will be in the integration status.',
      fr: 'Une connexion au Droplet est en cours : le résultat sera dans le statut de l’intégration.',
    },
    notYet: (wait, status) => ({
      en: bound(
        `${status.en} (Never two attempts less than 30 s apart: next one in ${delay(wait).en}.)`,
      ),
      fr: bound(
        `${status.fr} (Jamais deux essais à moins de 30 s : le prochain dans ${delay(wait).fr}.)`,
      ),
    }),
    reading: ({ id, flow, index, held }) => {
      const f = (lang) =>
        flow === undefined
          ? lang === 'en'
            ? 'flow not received in the last 2 minutes'
            : 'débit non reçu ces 2 dernières minutes'
          : lang === 'en'
            ? `flow ${Math.round(flow * 100) / 100} L/min`
            : `débit ${Math.round(flow * 100) / 100} L/min`;
      const i = (lang) =>
        index === undefined
          ? ''
          : lang === 'en'
            ? `, water index ${litres(index, 'en')}${held ? ' (a volume is held back)' : ''}`
            : `, index d’eau ${litres(index, 'fr')}${held ? ' (un volume est retenu)' : ''}`;
      return {
        en: `Connected to Droplet ${id}: ${f('en')}${i('en')}.`,
        fr: `Connecté au Droplet ${id} : ${f('fr')}${i('fr')}.`,
      };
    },
  },
};
