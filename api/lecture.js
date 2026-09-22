// FUSION — POST /api/lecture
// PASSE 2 de la lecture d'un état hypothécaire : lecture d'IMAGE par Claude,
// sur le seul résidu que la passe 1 (code, dans le navigateur) n'a pas pu
// pré-saisir — fiches scannées de l'ancien stock, PDF sans couche de texte.
//
// Arbitrages du 15/09/2026 :
//   - Claude en lecture d'image plutôt qu'un OCR classique : rendu directement
//     structuré, meilleure fiabilité sur les fiches anciennes ou manuscrites.
//   - GARDE-FOU DE COÛT : rien ne part sans un compteur de pages, un coût
//     estimé affiché, et la validation explicite d'un compte autorisé.
//   - À ce stade, SEUL JFD peut déclencher la passe 2. L'autorisation est
//     vérifiée ICI, côté serveur : le navigateur envoie son jeton Google (celui
//     de la connexion Drive), on demande à Google le courriel qu'il porte, et
//     on le compare à la liste LECTURE_AUTORISES. Un bouton grisé ne suffirait
//     pas, la clé API ne doit être dépensable que par les comptes nommés.
//   - Le résultat remplit LE MÊME contrat de sortie que la passe 1 (en-tête +
//     une ligne par mention, chaque champ portant sa page d'origine et son
//     moteur « claude »), et atterrit sur le même écran de contrôle.
//
// Variables d'environnement du projet Vercel `fusion` :
//   ANTHROPIC_API_KEY      obligatoire — clé API Anthropic
//   LECTURE_AUTORISES      obligatoire — courriels autorisés, séparés par des virgules
//   LECTURE_MODELE         facultatif  — modèle appelé (défaut : claude-sonnet-5)
//   LECTURE_COUT_PAGE_EUR  facultatif  — coût estimé par page affiché avant envoi (défaut : 0.03)
//
// Deux actions :
//   { action:"estimer", jeton }                  → { autorise, courriel, modele, coutPageEur }
//   { action:"lire", jeton, pages:[{numero, image}], contexte:{nom, groupe, parcelles} }
//                                                → { entete, mentions, usage, modele }
//   Les pages arrivent par LOTS (le navigateur enchaîne), en JPEG base64.

const MODELE_DEFAUT = 'claude-sonnet-5';
const COUT_PAGE_DEFAUT = 0.03;
const PAGES_MAX_PAR_LOT = 6;
const API = 'https://api.anthropic.com/v1/messages';

function autorises() {
  return String(process.env.LECTURE_AUTORISES || '')
    .split(/[,;\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);
}

// Le courriel porté par un jeton d'accès Google — même jeton que la connexion Drive du navigateur.
// On interroge Drive lui-même (about.user) : la portée « drive » suffit, sans portée courriel supplémentaire.
async function courrielDuJeton(jeton) {
  if (!jeton) return null;
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + jeton } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.user && j.user.emailAddress ? String(j.user.emailAddress).toLowerCase() : null;
}

function reglages() {
  return {
    modele: process.env.LECTURE_MODELE || MODELE_DEFAUT,
    coutPageEur: Number(process.env.LECTURE_COUT_PAGE_EUR) > 0 ? Number(process.env.LECTURE_COUT_PAGE_EUR) : COUT_PAGE_DEFAUT
  };
}

const CONSIGNE = `Tu lis des états hypothécaires français (fiches du service de la publicité foncière : états-réponses ANF récents, relevés de formalités, ou fiches d'immeuble anciennes scannées, parfois manuscrites). Tu reçois les images de pages numérotées d'un même document. Tu rends UNIQUEMENT un objet JSON, sans texte autour, sans balises de code.

Structure attendue :
{
  "entete": {
    "service":       {"valeur": "...", "page": n},   // service de la publicité foncière (ou conservation des hypothèques)
    "delivreLe":     {"valeur": "JJ/MM/AAAA", "page": n},
    "dossierANF":    {"valeur": "...", "page": n},
    "demandeNumero": {"valeur": "...", "page": n},
    "deposeeLe":     {"valeur": "JJ/MM/AAAA", "page": n},
    "periodeReleve": {"valeur": "du JJ/MM/AAAA au JJ/MM/AAAA", "page": n}
  },
  "mentions": [
    {
      "rubrique":   "publication" | "inscription" | "autre",
      "page":       n,                                  // page où la mention commence
      "natures":    {"valeur": "VENTE" , "page": n},    // nature de la formalité telle qu'écrite (VENTE, APPORT, HYPOTHÈQUE CONVENTIONNELLE, PRIVILÈGE DE PRÊTEUR DE DENIERS, SERVITUDE, BAIL EMPHYTÉOTIQUE...)
      "dateActe":   {"valeur": "JJ/MM/AAAA", "page": n},
      "dateDepot":  {"valeur": "JJ/MM/AAAA", "page": n},  // date de dépôt / de publication
      "redacteur":  {"valeur": "...", "page": n},       // notaire rédacteur, tel qu'écrit
      "commune":    {"valeur": "...", "page": n},       // commune de résidence du rédacteur
      "volume":     {"valeur": "2019P", "page": n},     // volume / référence d'enliassement
      "numero":     {"valeur": "1234", "page": n},
      "service":    {"valeur": "...", "page": n},       // service ayant publié, s'il est écrit
      "rang":       {"valeur": "premier", "page": n},   // pour une inscription
      "montant":    {"valeur": "125000.00", "page": n}, // prix, ou principal garanti — nombre en chiffres, point décimal
      "complement": {"valeur": "...", "page": n},       // toute précision utile : accessoires, date d'effet, mainlevée, radiation, périmée...
      "disposants":    [{"nom": "..."}],
      "beneficiaires": [{"nom": "..."}],
      "immeubles":     [{"commune": "...", "section": "AB", "numero": "123", "droit": "propriétaire" | "emphytéote" | "preneur à construction" | null}]
    }
  ]
}

Règles :
- Une entrée par formalité (mutation OU inscription OU autre mention). Ne fusionne jamais deux formalités.
- Si un champ n'est pas lisible ou absent, mets null (pas de chaîne vide, pas d'invention). Ne devine jamais une date ou un montant.
- Les dates sont toujours au format JJ/MM/AAAA. Les montants en chiffres, sans espace ni symbole, point comme séparateur décimal.
- "page" est le numéro de page indiqué dans le texte qui précède chaque image, pas un numéro imprimé sur la fiche.
- Les noms de parties sont recopiés tels qu'écrits, en capitales si la fiche les écrit en capitales.
- Sur une fiche ancienne manuscrite, lis ce qui est lisible et laisse null le reste : mieux vaut un champ vide qu'un champ faux. Un humain valide ensuite chaque ligne à l'écran, en regard de l'image.`;

function nettoyerJSON(texte) {
  let t = String(texte || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

function champ(c, pageDefaut) {
  if (!c) return null;
  const v = typeof c === 'object' ? c.valeur : c;
  if (v == null || v === '' || v === 'null') return null;
  const p = typeof c === 'object' && Number.isInteger(c.page) ? c.page : pageDefaut;
  return { valeur: String(v).trim(), page: p, moteur: 'claude' };
}

// Remise du rendu de Claude dans le contrat exact de la passe 1.
function normaliser(brut, premierePage) {
  const e = brut.entete || {};
  const entete = {};
  ['service', 'delivreLe', 'dossierANF', 'demandeNumero', 'deposeeLe', 'periodeReleve'].forEach((k) => { const c = champ(e[k], premierePage); if (c) entete[k] = c; });
  const mentions = (Array.isArray(brut.mentions) ? brut.mentions : []).map((m, i) => {
    const page = Number.isInteger(m.page) ? m.page : premierePage;
    const liste = (x) => (Array.isArray(x) ? x : []).map((p) => (typeof p === 'string' ? { nom: p } : { nom: String((p && p.nom) || '').trim() })).filter((p) => p.nom);
    const immeubles = (Array.isArray(m.immeubles) ? m.immeubles : []).map((im) => ({
      commune: im && im.commune ? String(im.commune).trim() : null,
      section: im && im.section ? String(im.section).trim().toUpperCase() : null,
      numero: im && im.numero != null ? String(im.numero).trim() : null,
      droit: im && im.droit ? String(im.droit) : null
    })).filter((im) => im.section && im.numero);
    return {
      index: i + 1,
      rubrique: m.rubrique || null,
      pages: { debut: page, fin: page },
      natures: champ(m.natures, page), redacteur: champ(m.redacteur, page), commune: champ(m.commune, page),
      dateActe: champ(m.dateActe, page), dateDepot: champ(m.dateDepot, page), volume: champ(m.volume, page),
      numero: champ(m.numero, page), service: champ(m.service, page), rang: champ(m.rang, page),
      montant: champ(m.montant, page), complement: champ(m.complement, page),
      disposants: liste(m.disposants), beneficiaires: liste(m.beneficiaires), immeubles,
      valide: false
    };
  });
  return { entete, mentions };
}

async function lire(res, corps, courriel) {
  const { modele } = reglages();
  const cle = process.env.ANTHROPIC_API_KEY;
  if (!cle) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY absente du projet Vercel' });
  const pages = Array.isArray(corps.pages) ? corps.pages.filter((p) => p && Number.isInteger(p.numero) && typeof p.image === 'string' && p.image.length > 100) : [];
  if (!pages.length) return res.status(400).json({ erreur: 'pages vide' });
  if (pages.length > PAGES_MAX_PAR_LOT) return res.status(413).json({ erreur: `lot trop gros (${pages.length} > ${PAGES_MAX_PAR_LOT})` });

  const ctx = corps.contexte || {};
  const parcelles = Array.isArray(ctx.parcelles) ? ctx.parcelles.slice(0, 200) : [];
  const contenu = [{
    type: 'text',
    text: `Document : ${ctx.nom || 'état hypothécaire'}${ctx.groupe ? ', groupe ' + ctx.groupe : ''}.`
      + (parcelles.length ? ` Parcelles du groupe attendues (à titre indicatif, pour aider à lire les références) : ${parcelles.map((p) => [p.commune, p.section, p.numero].filter(Boolean).join(' ')).join(' ; ')}.` : '')
      + ` Voici ${pages.length} page${pages.length > 1 ? 's' : ''} de ce document.`
  }];
  for (const p of pages) {
    contenu.push({ type: 'text', text: `Page ${p.numero}` });
    contenu.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.image.replace(/^data:[^,]+,/, '') } });
  }

  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cle, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modele, max_tokens: 8000, system: CONSIGNE, messages: [{ role: 'user', content: contenu }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = (j && j.error && j.error.message) || `HTTP ${r.status}`;
    return res.status(502).json({ erreur: 'Anthropic — ' + detail });
  }
  const texte = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let brut;
  try { brut = nettoyerJSON(texte); }
  catch (e) { return res.status(502).json({ erreur: 'réponse non structurée du modèle', extrait: texte.slice(0, 300) }); }
  const resultat = normaliser(brut, pages[0].numero);
  return res.status(200).json({
    ...resultat,
    modele,
    courriel,
    pages: pages.map((p) => p.numero),
    usage: j.usage ? { entree: j.usage.input_tokens, sortie: j.usage.output_tokens } : null
  });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
    const corps = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const liste = autorises();
    const courriel = await courrielDuJeton(corps.jeton);
    const autorise = Boolean(courriel) && liste.includes(courriel);
    const { modele, coutPageEur } = reglages();

    if (corps.action === 'estimer') {
      return res.status(200).json({
        autorise, courriel, modele, coutPageEur,
        pagesMaxParLot: PAGES_MAX_PAR_LOT,
        configure: Boolean(process.env.ANTHROPIC_API_KEY) && liste.length > 0,
        motif: !process.env.ANTHROPIC_API_KEY ? 'clé API absente' : !liste.length ? 'aucun compte autorisé (LECTURE_AUTORISES vide)' : !courriel ? 'jeton Google absent ou expiré' : !autorise ? 'compte non autorisé' : null
      });
    }
    if (corps.action === 'lire') {
      if (!autorise) return res.status(403).json({ erreur: 'Passe 2 réservée aux comptes autorisés', courriel: courriel || null });
      return await lire(res, corps, courriel);
    }
    return res.status(400).json({ erreur: 'action inconnue', actions: ['estimer', 'lire'] });
  } catch (e) {
    return res.status(500).json({ erreur: e.message || String(e) });
  }
}
