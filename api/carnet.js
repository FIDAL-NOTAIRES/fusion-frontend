// FUSION — POST /api/carnet
// Lecture de l'annuaire commun CARNET (associés et collaborateurs de l'étude),
// de serveur à serveur. Arbitrage du 12/11/2026 : FUSION ne tient pas sa propre
// liste ; l'associé en charge et le collaborateur d'un dossier se choisissent
// dans CARNET, et FUSION en tire le courriel du destinataire des demandes de
// pièces. La clé de lecture donnée par CARNET à FUSION ne quitte jamais le
// serveur.
//
// Garde : le navigateur envoie son jeton Google (celui de la connexion Drive) ;
// on demande à Google le courriel qu'il porte, et seul un compte de l'étude
// (domaine CARNET_DOMAINE, défaut fidal.notaires.fr) reçoit la liste.
//
// Variables d'environnement du projet Vercel `fusion` :
//   CARNET_URL      obligatoire — adresse de CARNET (https://carnet-ivory.vercel.app)
//   CARNET_CLE      obligatoire — clé de lecture créée dans CARNET pour l'outil FUSION
//   CARNET_DOMAINE  facultatif  — domaine des comptes admis (défaut : fidal.notaires.fr)
//
//   { jeton } → { personnes: [{ id, nom, prenom, initiales, categorie, courriel, site, sig }] }
//   Seuls les actifs, et seuls les champs utiles à FUSION, sont rendus.

async function courrielDuJeton(jeton) {
  if (!jeton) return null;
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + jeton } });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j.user && j.user.emailAddress ? String(j.user.emailAddress).toLowerCase() : null;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
    const corps = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const url = String(process.env.CARNET_URL || '').replace(/\/+$/, '');
    const cle = process.env.CARNET_CLE || '';
    if (!url || !cle) return res.status(503).json({ erreur: 'CARNET n\'est pas branché : variables CARNET_URL et CARNET_CLE absentes sur FUSION.' });

    const domaine = String(process.env.CARNET_DOMAINE || 'fidal.notaires.fr').toLowerCase();
    const courriel = await courrielDuJeton(corps.jeton);
    if (!courriel) return res.status(401).json({ erreur: 'Jeton Google absent ou expiré — reconnectez le Drive.' });
    if (!courriel.endsWith('@' + domaine)) return res.status(403).json({ erreur: 'Annuaire réservé aux comptes de l\'étude.', courriel });

    const r = await fetch(url + '/api/carnet?action=lecture', { headers: { 'X-Carnet-Cle': cle } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ erreur: 'CARNET a refusé la lecture — ' + (d.erreur || 'HTTP ' + r.status) });

    const personnes = (d.personnes || []).filter((p) => p && p.actif !== false).map((p) => ({
      id: p.id, nom: p.nom || '', prenom: p.prenom || '', initiales: p.initiales || '',
      categorie: p.categorie === 'associe' ? 'associe' : 'collaborateur',
      courriel: p.courriel || '', site: p.site && p.site.nom ? p.site.nom : '',
      // 16/11/2026 : champs de la signature commune des courriels (même rendu que CARNET et ARGOSAdmin)
      sig: {
        sans_signature: !!p.sans_signature, fonction: p.fonction || '', ligne2: p.ligne2 || '', couleur: p.couleur || '',
        telephone: p.telephone || '', site_tel: p.site && p.site.telephone ? p.site.telephone : '',
        site_adresse: p.site && p.site.adresse ? p.site.adresse : '', site_cp: p.site && p.site.code_postal ? p.site.code_postal : '',
      },
    }));
    return res.status(200).json({ personnes });
  } catch (e) {
    console.error('[fusion] carnet', e);
    return res.status(500).json({ erreur: 'Erreur serveur' });
  }
}
