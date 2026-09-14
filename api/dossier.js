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
//     renumeroter { siren, concordance:[{ancien, nouveau}] }        → renumérotation complète (géographique)
//     drive       { siren, dossier?:{...}, groupes?:[{numero, drive}] } → identifiants Drive
//     document    { siren, document:{drive_id, groupe, nom, type, …} }  → dépôt ou requalification d'une pièce
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
  const [d] = await sql`SELECT id, siren, denomination, millesime, etat, drive, cree_le, modifie_le FROM fusion_dossier WHERE siren = ${siren}`;
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
  const groupes = await sql`SELECT numero, manuel, drive FROM fusion_groupe WHERE dossier_id = ${d.id} ORDER BY numero`;
  const parcelles = await sql`SELECT idu, props, contour, groupe FROM fusion_parcelle WHERE dossier_id = ${d.id} ORDER BY idu`;
  const documents = await sql`SELECT id, groupe, drive_id, drive_parent, nom, nom_origine, type, code, piece, date_doc, date_sure, empreinte, taille, mime, couche_texte, statut, depose_le
                              FROM fusion_document WHERE dossier_id = ${d.id} ORDER BY groupe, nom`;
  const journal = await sql`SELECT quand, quoi, detail FROM fusion_journal WHERE dossier_id = ${d.id} ORDER BY quand DESC LIMIT 50`;
  return res.status(200).json({
    dossier: { siren: d.siren, denomination: d.denomination, millesime: d.millesime, etat: d.etat, drive: d.drive || {}, cree_le: d.cree_le, modifie_le: d.modifie_le },
    groupes, parcelles, documents, journal,
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
  // les identifiants Drive déjà connus survivent à la réécriture du découpage
  const anciens = await sql`SELECT numero, drive FROM fusion_groupe WHERE dossier_id = ${d.id}`;
  const driveParNumero = new Map(anciens.map((g) => [g.numero, g.drive || {}]));
  const lignesAvecDrive = lignesGroupes.map((g) => ({ ...g, drive: driveParNumero.get(g.numero) || {} }));
  await sql.transaction([
    sql`DELETE FROM fusion_groupe WHERE dossier_id = ${d.id}`,
    sql`INSERT INTO fusion_groupe (dossier_id, numero, manuel, drive)
        SELECT ${d.id}, x.numero, x.manuel, x.drive
        FROM jsonb_to_recordset(${JSON.stringify(lignesAvecDrive)}::jsonb) AS x(numero integer, manuel boolean, drive jsonb)`,
    sql`UPDATE fusion_parcelle SET groupe = NULL WHERE dossier_id = ${d.id}`,
    sql`UPDATE fusion_parcelle p SET groupe = x.groupe
        FROM jsonb_to_recordset(${JSON.stringify(appartenance)}::jsonb) AS x(idu text, groupe integer)
        WHERE p.dossier_id = ${d.id} AND p.idu = x.idu`,
    sql`UPDATE fusion_dossier SET etat = ${JSON.stringify(etat)}::jsonb, modifie_le = now() WHERE id = ${d.id}`,
  ]);
  if (corps.quoi) await journaliser(sql, d.id, String(corps.quoi), corps.detail || {});
  return res.status(200).json({ ok: true, groupes: lignesGroupes.length, parcelles: appartenance.length });
}

// Renumérotation complète : ancien → nouveau sur groupes, parcelles et documents,
// en une transaction, avec le tableau de concordance au journal. Les fichiers
// Drive sont renommés PAR LE NAVIGATEUR (il détient le jeton) ; ici on ne
// touche qu'à la base. Passage par des numéros négatifs pour éviter toute
// collision de clé pendant la permutation.
async function renumeroter(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const conc = Array.isArray(corps.concordance) ? corps.concordance.filter((c) => Number.isInteger(c.ancien) && Number.isInteger(c.nouveau)) : [];
  if (!conc.length) return res.status(400).json({ erreur: 'concordance vide' });
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu' });
  const j = JSON.stringify(conc);
  await sql.transaction([
    sql`UPDATE fusion_groupe g SET numero = -x.nouveau FROM jsonb_to_recordset(${j}::jsonb) AS x(ancien integer, nouveau integer) WHERE g.dossier_id = ${d.id} AND g.numero = x.ancien`,
    sql`UPDATE fusion_parcelle p SET groupe = -x.nouveau FROM jsonb_to_recordset(${j}::jsonb) AS x(ancien integer, nouveau integer) WHERE p.dossier_id = ${d.id} AND p.groupe = x.ancien`,
    sql`UPDATE fusion_document doc SET groupe = -x.nouveau FROM jsonb_to_recordset(${j}::jsonb) AS x(ancien integer, nouveau integer) WHERE doc.dossier_id = ${d.id} AND doc.groupe = x.ancien`,
    sql`UPDATE fusion_groupe SET numero = -numero WHERE dossier_id = ${d.id} AND numero < 0`,
    sql`UPDATE fusion_parcelle SET groupe = -groupe WHERE dossier_id = ${d.id} AND groupe < 0`,
    sql`UPDATE fusion_document SET groupe = -groupe WHERE dossier_id = ${d.id} AND groupe < 0`,
    sql`UPDATE fusion_dossier SET etat = etat || ${JSON.stringify({ numerotation_definitive: new Date().toISOString() })}::jsonb, modifie_le = now() WHERE id = ${d.id}`,
  ]);
  await journaliser(sql, d.id, 'renumerotation', { concordance: conc, ordre: corps.ordre || 'SPF > commune > section' });
  return res.status(200).json({ ok: true, groupes: conc.length });
}

async function drive(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu' });
  const requetes = [];
  if (corps.dossier && typeof corps.dossier === 'object') {
    requetes.push(sql`UPDATE fusion_dossier SET drive = drive || ${JSON.stringify(corps.dossier)}::jsonb, modifie_le = now() WHERE id = ${d.id}`);
  }
  const groupes = Array.isArray(corps.groupes) ? corps.groupes.filter((g) => Number.isInteger(g.numero) && g.drive && typeof g.drive === 'object') : [];
  if (groupes.length) {
    requetes.push(sql`UPDATE fusion_groupe g SET drive = g.drive || x.drive
                      FROM jsonb_to_recordset(${JSON.stringify(groupes)}::jsonb) AS x(numero integer, drive jsonb)
                      WHERE g.dossier_id = ${d.id} AND g.numero = x.numero`);
  }
  if (!requetes.length) return res.status(400).json({ erreur: 'rien à enregistrer' });
  await sql.transaction(requetes);
  if (corps.dossier && corps.dossier.societe) await journaliser(sql, d.id, 'drive-cree', { societe: corps.dossier.societe, nom: corps.dossier.nom || null });
  return res.status(200).json({ ok: true, groupes: groupes.length });
}

async function document(res, corps) {
  const sql = db();
  const siren = sirenPropre(corps.siren);
  if (!siren) return res.status(400).json({ erreur: 'siren invalide' });
  const doc = corps.document;
  if (!doc || !doc.drive_id || !Number.isInteger(doc.groupe) || !doc.nom || !doc.type) return res.status(400).json({ erreur: 'document incomplet (drive_id, groupe, nom, type)' });
  const d = await dossierParSiren(sql, siren);
  if (!d) return res.status(404).json({ erreur: 'dossier inconnu' });
  const [existant] = await sql`SELECT id, nom, type, groupe FROM fusion_document WHERE drive_id = ${doc.drive_id}`;
  const [r] = await sql`
    INSERT INTO fusion_document (dossier_id, groupe, drive_id, drive_parent, nom, nom_origine, type, code, piece, date_doc, date_sure, empreinte, taille, mime, couche_texte, statut)
    VALUES (${d.id}, ${doc.groupe}, ${doc.drive_id}, ${doc.drive_parent || null}, ${doc.nom}, ${doc.nom_origine || null}, ${doc.type}, ${doc.code || null}, ${doc.piece || null},
            ${doc.date_doc || null}, ${Boolean(doc.date_sure)}, ${doc.empreinte || null}, ${Number.isInteger(doc.taille) ? doc.taille : null}, ${doc.mime || null},
            ${typeof doc.couche_texte === 'boolean' ? doc.couche_texte : null}, ${doc.statut || 'depose'})
    ON CONFLICT (drive_id) DO UPDATE SET
      groupe = EXCLUDED.groupe, drive_parent = EXCLUDED.drive_parent, nom = EXCLUDED.nom, type = EXCLUDED.type, code = EXCLUDED.code, piece = EXCLUDED.piece,
      date_doc = EXCLUDED.date_doc, date_sure = EXCLUDED.date_sure, statut = EXCLUDED.statut, modifie_le = now()
    RETURNING id`;
  await journaliser(sql, d.id, existant ? 'requalification' : 'depot',
    existant ? { document: r.id, groupe: doc.groupe, ancien_nom: existant.nom, nouveau_nom: doc.nom, ancien_type: existant.type, nouveau_type: doc.type }
             : { document: r.id, groupe: doc.groupe, nom: doc.nom, nom_origine: doc.nom_origine || null, type: doc.type, drive_id: doc.drive_id });
  return res.status(200).json({ ok: true, id: r.id, cree: !existant });
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
      case 'renumeroter': return await renumeroter(res, corps);
      case 'drive':       return await drive(res, corps);
      case 'document':    return await document(res, corps);
      case 'journal':     return await journal(res, corps);
      default:            return res.status(400).json({ erreur: 'action inconnue', actions: ['initialiser', 'parcelles', 'groupes', 'renumeroter', 'drive', 'document', 'journal'] });
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
