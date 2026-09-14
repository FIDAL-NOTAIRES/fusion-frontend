// FUSION — /api/dossier — ROUTE UNIQUE DE LA PERSISTANCE
//
// Une seule fonction à actions, sur le modèle de MARTEAU api/dossier.js : le
// plan Hobby plafonne à DOUZE fonctions par déploiement, on ne les dépense pas
// une par route. FUSION en est à DEUX (redpar, dossier).
//
// Pourquoi une base et non un JSON de navigateur : le découpage d'une société
// en unités foncières se valide en plusieurs fois, groupe par groupe, sur des
// jours. Un rafraîchissement ne doit rien perdre, et le dossier doit se rouvrir
// depuis n'importe quel poste. Les contours sont stockés tels que REDPAR les a
// servis : la réouverture ne repasse ni par REDPAR ni par Etalab.
//
// RÈGLE : un dossier existant n'est JAMAIS écrasé par un rechargement REDPAR
// implicite. Seule l'action `initialiser` (bouton explicite côté écran) repart
// du relevé et efface le découpage — et elle le journalise.
//
// ---------------------------------------------------------------------
// SURFACE D'APPEL
//
//   GET  /api/dossier?liste=1            → dossiers enregistrés (siren, dénomination, comptes, dates)
//   GET  /api/dossier?siren=123456789    → un dossier complet : groupes, parcelles avec contours, etat
//
//   POST /api/dossier  { action, siren, ... }
//     initialiser { siren, denomination, millesime, etat }        → crée ou vide le dossier
//     parcelles   { siren, parcelles:[{idu, props, contour, groupe}] } → ajoute un lot (≤ 500)
//     groupes     { siren, groupes:[{numero, manuel, idus[]}], etat } → réécrit le découpage
//     journal     { siren, quoi, detail }                          → trace libre
//
// Toutes les tables portent le préfixe fusion_ : base partagée avec MATRICE,
// MARTEAU et PARTAGE AMIABLE.

import { neon } from '@neondatabase/serverless';

let _sql;
function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL absente — la fonction ne peut pas servir');
  _sql ??= neon(process.env.DATABASE_URL);
  return _sql;
}

const LOT_MAX = 500;

function sirenPropre(v) {
  const s = String(v || '').replace(/\s+/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}

async function dossierParSiren(sql, siren) {
  const [d] = await sql`SELECT id, siren, denomination, millesime, etat, cree_le, modifie_le FROM fusion_dossier WHERE siren = ${siren}`;
  return d || null;
}

async function journaliser(sql, dossierId, quoi, detail = {}) {
  await sql`INSERT INTO fusion_journal (dossier_id, quoi, detail) VALUES (${dossierId}, ${quoi}, ${JSON.stringify(detail)}::jsonb)`;
}

// ---- GET ----
async function lister(res) {
  const sql = db();
  const lignes = await sql`
    SELECT d.siren, d.denomination, d.millesime, d.cree_le, d.modifie_le,
           (SELECT count(*) FROM fusion_groupe   g WHERE g.dossier_id = d.id)::int AS groupes,
           (SELECT count(*) FROM fusion_groupe   g WHERE g.dossier_id = d.id AND g.manuel)::int AS groupes_manuels,
           (SELECT count(*) FROM fusion_parcelle p WHERE p.dossier_id = d.id)::int AS parcelles,
           (SELECT count(*) FROM fusion_parcelle p WHERE p.dossier_id = d.id AND p.contour IS NOT NULL)::int AS avec_contour
    FROM fusion_dossier d
    ORDER BY d.modifie_le DESC`;
  return res.status(200).json({ dossiers: lignes });
}

async function charger(res, siren) {
  const sql = db();
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'Aucun dossier FUSION pour ce SIREN', siren });
  const groupes = await sql`SELECT numero, manuel FROM fusion_groupe WHERE dossier_id = ${d.id} ORDER BY numero`;
  const parcelles = await sql`SELECT idu, props, contour, groupe FROM fusion_parcelle WHERE dossier_id = ${d.id} ORDER BY idu`;
  const journal = await sql`SELECT quand, quoi, detail FROM fusion_journal WHERE dossier_id = ${d.id} ORDER BY quand DESC LIMIT 50`;
  return res.status(200).json({
    dossier: { siren: d.siren, denomination: d.denomination, millesime: d.millesime, etat: d.etat, cree_le: d.cree_le, modifie_le: d.modifie_le },
    groupes, parcelles, journal,
  });
}

// ---- POST ----
async function initialiser(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const etat = corps.etat && typeof corps.etat === 'object' ? corps.etat : {};
  const existant = await dossierParSiren(sql, siren);
  let id;
  if (existant) {
    id = existant.id;
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM fusion_groupe WHERE dossier_id = ${id} AND manuel`;
    await sql.transaction([
      sql`DELETE FROM fusion_parcelle WHERE dossier_id = ${id}`,
      sql`DELETE FROM fusion_groupe WHERE dossier_id = ${id}`,
      sql`UPDATE fusion_dossier SET denomination = COALESCE(${corps.denomination || null}, denomination),
                                   millesime = COALESCE(${corps.millesime || null}, millesime),
                                   etat = ${JSON.stringify(etat)}::jsonb, modifie_le = now()
           WHERE id = ${id}`,
    ]);
    await journaliser(sql, id, 'reinitialisation', { groupes_manuels_perdus: n, millesime: corps.millesime || null });
  } else {
    const [d] = await sql`INSERT INTO fusion_dossier (siren, denomination, millesime, etat)
                          VALUES (${siren}, ${corps.denomination || null}, ${corps.millesime || null}, ${JSON.stringify(etat)}::jsonb)
                          RETURNING id`;
    id = d.id;
    await journaliser(sql, id, 'ouverture', { denomination: corps.denomination || null, millesime: corps.millesime || null });
  }
  return res.status(200).json({ ok: true, siren, cree: !existant });
}

async function parcelles(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const lot = Array.isArray(corps.parcelles) ? corps.parcelles : [];
  if (!lot.length) return res.status(400).json({ erreur: 'parcelles vide' });
  if (lot.length > LOT_MAX) return res.status(413).json({ erreur: `lot trop gros (${lot.length} > ${LOT_MAX})` });
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu — appeler initialiser d’abord' });
  const lignes = lot
    .filter((p) => p && typeof p.idu === 'string' && p.idu.length === 14)
    .map((p) => ({ idu: p.idu, props: p.props || {}, contour: p.contour || null, groupe: Number.isInteger(p.groupe) ? p.groupe : null }));
  await sql`
    INSERT INTO fusion_parcelle (dossier_id, idu, props, contour, groupe)
    SELECT ${d.id}, x.idu, x.props, x.contour, x.groupe
    FROM jsonb_to_recordset(${JSON.stringify(lignes)}::jsonb) AS x(idu text, props jsonb, contour jsonb, groupe integer)
    ON CONFLICT (dossier_id, idu) DO UPDATE SET props = EXCLUDED.props, contour = EXCLUDED.contour, groupe = EXCLUDED.groupe`;
  return res.status(200).json({ ok: true, inserees: lignes.length });
}

async function groupes(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const liste = Array.isArray(corps.groupes) ? corps.groupes : [];
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu — appeler initialiser d’abord' });

  const lignesGroupes = liste
    .filter((g) => Number.isInteger(g.numero))
    .map((g) => ({ numero: g.numero, manuel: Boolean(g.manuel) }));
  const appartenance = [];
  liste.forEach((g) => (g.idus || []).forEach((idu) => appartenance.push({ idu, groupe: g.numero })));

  const etat = corps.etat && typeof corps.etat === 'object' ? corps.etat : d.etat;
  await sql.transaction([
    sql`DELETE FROM fusion_groupe WHERE dossier_id = ${d.id}`,
    sql`INSERT INTO fusion_groupe (dossier_id, numero, manuel)
        SELECT ${d.id}, x.numero, x.manuel
        FROM jsonb_to_recordset(${JSON.stringify(lignesGroupes)}::jsonb) AS x(numero integer, manuel boolean)`,
    sql`UPDATE fusion_parcelle SET groupe = NULL WHERE dossier_id = ${d.id}`,
    sql`UPDATE fusion_parcelle p SET groupe = x.groupe
        FROM jsonb_to_recordset(${JSON.stringify(appartenance)}::jsonb) AS x(idu text, groupe integer)
        WHERE p.dossier_id = ${d.id} AND p.idu = x.idu`,
    sql`UPDATE fusion_dossier SET etat = ${JSON.stringify(etat)}::jsonb, modifie_le = now() WHERE id = ${d.id}`,
  ]);
  if (corps.quoi) await journaliser(sql, d.id, String(corps.quoi), corps.detail || {});
  return res.status(200).json({ ok: true, groupes: lignesGroupes.length, parcelles: appartenance.length });
}

async function journal(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren || !corps.quoi) return res.status(400).json({ erreur: 'siren et quoi requis' });
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu' });
  await journaliser(sql, d.id, String(corps.quoi), corps.detail || {});
  return res.status(200).json({ ok: true });
}

// ---- entrée ----
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (req.query.liste) return await lister(res);
      const siren = sirenPropre(req.query.siren);
      if (!siren) return res.status(400).json({ erreur: 'siren requis (9 chiffres), ou liste=1' });
      return await charger(res, siren);
    }
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'GET ou POST attendu' });
    const corps = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    switch (corps.action) {
      case 'initialiser': return await initialiser(res, corps);
      case 'parcelles':   return await parcelles(res, corps);
      case 'groupes':     return await groupes(res, corps);
      case 'journal':     return await journal(res, corps);
      default:            return res.status(400).json({ erreur: 'action inconnue', actions: ['initialiser', 'parcelles', 'groupes', 'journal'] });
    }
  } catch (e) {
    const motif = String((e && e.message) || e);
    const permission = /permission denied/i.test(motif);
    return res.status(500).json({
      erreur: permission ? 'Base : permission refusée — le GRANT du schéma public n’a pas été exécuté (voir sql/fusion.sql)' : 'Base indisponible',
      motif,
    });
  }
}
