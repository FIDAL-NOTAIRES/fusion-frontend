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
// Paramètres :
//   ?siren=123456789       (l'un des deux requis)
//   ?nom=LOGIS METROPOLE
//
// Réponse :
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

  const { siren, nom } = req.query || {};
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

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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
