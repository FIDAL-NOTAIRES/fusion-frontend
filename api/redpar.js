// FUSION — GET /api/redpar
// L'ORCHESTRATEUR. Seul endroit de FUSION qui appelle REDPAR, sur le modèle de
// MARTEAU api/photo.js : FUSION APPELLE, il ne duplique pas. Si REDPAR corrige
// sa recherche MAJIC ou son repli millésime, FUSION en profite sans report.
//
// Pourquoi côté serveur : on enchaîne deux volets REDPAR (références par
// société, puis contours commune par commune) et on assemble une
// FeatureCollection prête pour le moteur de regroupement du navigateur. Ça
// évite aussi toute question de CORS entre domaines Vercel.
//
// ÉCHEC EXPLICITE, JAMAIS SILENCIEUX. Une commune dont le plan ne répond pas
// est nommée dans `indisponible` ; une référence sans géométrie est listée
// dans `sansGeometrie` : elle existe au relevé, elle n'est pas dessinable.
//
// DEUX ÉTAPES pilotées par le navigateur (v2, 12/09/2026) — une seule fonction
// à actions, pour ne pas entamer les douze du plan Hobby :
//   ?etape=societes&q=…                → les sociétés candidates (annuaire officiel
//                                        via REDPAR /api/search) : dénomination, forme
//                                        juridique, Active/Cessée, SIREN, création,
//                                        siège, APE, dirigeants — à choisir AVANT toute
//                                        recherche cadastrale (même réflexe que REDPAR)
//   ?etape=references&siren=…|nom=…   → la société, ses références, la liste des
//                                        communes ; rapide, une seule requête REDPAR
//   ?etape=contours&insee=…&ids=…      → les contours d'UNE commune (lots de 150
//     [&cible=AAAA-MM-JJ]                 références) ; le navigateur enchaîne les
//                                        communes et affiche « 12 sur 47 », ce qui
//                                        alimente ATTENTE et évite le plafond de 60 s
//                                        sur les gros portefeuilles (LOGIS : 47 communes)
//   sans etape                          → tout d'un coup (petites sociétés, tests)
//
// Réponse complète (sans etape) :
//   { societe, candidats, millesime, total, avecGeometrie, sansGeometrie: [...],
//     indisponible: [...], geojson: FeatureCollection }

const REDPAR = process.env.REDPAR_BASE || 'https://redpar-backend.vercel.app';
const LIMITE = 20000;          // même plafond que MARTEAU
const LOT_IDS = 150;           // références par appel /api/geo (longueur d'URL)
const PARALLELE = 6;           // appels /api/geo simultanés

async function volet(chemin, params) {
  const url = new URL(chemin, REDPAR);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`REDPAR ${chemin} — HTTP ${r.status}`);
  return r.json();
}

// « 2025 » ou « 2025-01-01 » → « 2025-01-01 » ; sinon null (pas de cible).
function cibleMillesime(m) {
  if (!m) return null;
  const s = String(m).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function decouperRef(ref) {
  // 14 caractères : commune 5 + préfixe 3 + section 2 + numéro 4
  const r = String(ref || '');
  return {
    commune: r.slice(0, 5), prefixe: r.slice(5, 8),
    section: r.slice(8, 10).trim(), numero: r.slice(10, 14),
  };
}

async function enParallele(taches, largeur) {
  const resultats = new Array(taches.length);
  let i = 0;
  async function ouvrier() {
    while (i < taches.length) {
      const k = i++;
      resultats[k] = await taches[k]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(largeur, taches.length) }, ouvrier));
  return resultats;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ erreur: 'Méthode non autorisée' });

  const { siren, nom, etape } = req.query || {};
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // ---- étape « societes » : cartes de l'annuaire officiel, via REDPAR ----
  if (etape === 'societes') {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ erreur: 'Paramètre q requis (2 caractères minimum)' });
    try {
      const S = await volet('/api/search', { q });
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ q, societes: S.results || [] });
    } catch (e) {
      return res.status(502).json({ erreur: 'REDPAR indisponible — annuaire des entreprises inaccessible', motif: String(e && e.message || e) });
    }
  }

  // ---- étape « contours » : une commune, un lot de références ----
  if (etape === 'contours') {
    const { insee, ids, cible: cibleQ } = req.query;
    if (!insee || !ids) return res.status(400).json({ erreur: 'Paramètres insee et ids requis' });
    const params = { insee, ids, contours: 1 };
    const c = cibleMillesime(cibleQ);
    if (c) params.cible = c;
    try {
      const G = await volet('/api/geo', params);
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ insee, geo: G.geo || {}, manquants: G.manquants || [], millesimes_essayes: G.millesimes_essayes || [] });
    } catch (e) {
      return res.status(502).json({ erreur: 'Plan indisponible pour la commune ' + insee, motif: String(e && e.message || e) });
    }
  }

  if (!siren && !nom) return res.status(400).json({ erreur: 'Paramètre siren ou nom requis' });
  const cible = siren ? { siren: String(siren).replace(/\s+/g, '') } : { nom };

  // ---- volet 1 : références au nom de la société ----
  let P;
  try {
    P = await volet('/api/parcelles', { ...cible, limite: LIMITE });
  } catch (e) {
    return res.status(502).json({ erreur: 'REDPAR indisponible — recherche des parcelles impossible', motif: String(e && e.message || e) });
  }

  const parcelles = P.results || [];
  const ech = parcelles[0] || {};
  const societe = {
    denomination: ech.denomination || (P.resolution && P.resolution.nom_recherche) || nom || null,
    siren: ech.numero_siren || (P.resolution && P.resolution.siren_retenu) || cible.siren || null,
    forme_juridique: ech.forme_juridique || null,
  };
  const candidats = (P.resolution && P.resolution.candidats) || [];
  const millesime = P.millesime || null;

  if (etape === 'references') {
    const communes = new Map();
    for (const p of parcelles) {
      const ref = String(p.code_parcelle || '');
      if (ref.length !== 14) continue;
      const insee = p.code_insee || ref.slice(0, 5);
      if (!communes.has(insee)) communes.set(insee, { insee, nom_commune: p.nom_commune || null, references: [] });
      communes.get(insee).references.push({
        idu: ref, nom_commune: p.nom_commune || null,
        contenance: Number(p.contenance_parcelle || p.contenance || 0) || null,
        droit: p.code_droit || null, nature: p.nature_culture || null, adresse: p.adresse || null,
      });
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      societe, candidats, millesime, cible: cibleMillesime(millesime),
      total: P.total ?? parcelles.length, tronque: Boolean(P.tronque),
      avertissement: P.avertissement || null,
      communes: [...communes.values()].sort((a, b) => b.references.length - a.references.length),
      lotReferences: LOT_IDS,
    });
  }

  if (!parcelles.length) {
    return res.status(200).json({
      societe, candidats, millesime, total: P.total ?? 0,
      avecGeometrie: 0, sansGeometrie: [], indisponible: [],
      geojson: { type: 'FeatureCollection', features: [] },
      tronque: Boolean(P.tronque), avertissement: P.avertissement || null,
    });
  }

  // ---- volet 2 : contours, commune par commune, par lots ----
  const parCommune = new Map();
  for (const p of parcelles) {
    const ref = String(p.code_parcelle || '');
    if (ref.length !== 14) continue;
    const insee = p.code_insee || ref.slice(0, 5);
    if (!parCommune.has(insee)) parCommune.set(insee, []);
    parCommune.get(insee).push(p);
  }

  const cibleM = cibleMillesime(millesime);
  const taches = [];
  for (const [insee, liste] of parCommune) {
    for (let d = 0; d < liste.length; d += LOT_IDS) {
      const lot = liste.slice(d, d + LOT_IDS);
      taches.push(async () => {
        const params = { insee, ids: lot.map((p) => p.code_parcelle).join(','), contours: 1 };
        if (cibleM) params.cible = cibleM;
        try {
          const G = await volet('/api/geo', params);
          return { insee, lot, geo: G.geo || {}, erreur: null };
        } catch (e) {
          return { insee, lot, geo: {}, erreur: String(e && e.message || e) };
        }
      });
    }
  }
  const lots = await enParallele(taches, PARALLELE);

  // ---- assemblage ----
  const features = [];
  const sansGeometrie = [];
  const communesEnEchec = new Map();

  for (const { insee, lot, geo, erreur } of lots) {
    if (erreur) communesEnEchec.set(insee, erreur);
    for (const p of lot) {
      const ref = p.code_parcelle;
      const g = geo[ref];
      const d = decouperRef(ref);
      const props = {
        idu: ref,
        commune: insee,
        nom_commune: p.nom_commune || null,
        prefixe: d.prefixe, section: d.section, numero: d.numero,
        contenance: Number(p.contenance_parcelle || p.contenance || 0) || null,
        droit: p.code_droit || null,
        nature: p.nature_culture || null,
        adresse: p.adresse || null,
        millesime_plan: g ? g.millesime_plan || null : null,
      };
      if (g && g.contour) {
        features.push({ type: 'Feature', properties: props, geometry: g.contour });
      } else {
        sansGeometrie.push({ ...props, motif: erreur ? 'plan indisponible' : 'absente de tous les millésimes essayés' });
      }
    }
  }

  const indisponible = [...communesEnEchec].map(([insee, motif]) => ({ commune: insee, motif }));

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.status(200).json({
    societe, candidats, millesime,
    total: P.total ?? parcelles.length,
    avecGeometrie: features.length,
    sansGeometrie,
    indisponible,
    tronque: Boolean(P.tronque),
    avertissement: P.avertissement || null,
    genere_le: new Date().toISOString(),
    geojson: { type: 'FeatureCollection', features },
  });
}
