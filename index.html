// FUSION — api/_acces.js — vérification de la personne côté serveur (lot 5 de CARNET, 26/11/2026)
//
// Jusqu'ici le voile de CARNET ne protégeait que l'ÉCRAN : quiconque connaissait l'adresse d'une fonction du serveur
// pouvait l'appeler sans être connecté. Désormais la page joint à chaque appel la connexion de la personne
// (en-tête X-Carnet-Jeton, celle que le voile garde sur le poste) et la fonction demande à CARNET, de serveur à serveur,
// qui est cette personne et quels outils lui sont ouverts (action « p_moi », la même que celle du voile).
//
// Aucun secret partagé, aucune variable nouvelle : seul CARNET sait lire une connexion.
//   CARNET_URL (facultatif) — adresse de CARNET ; à défaut https://carnet-ivory.vercel.app
//
// Réponse de CARNET gardée cinq minutes en mémoire : un droit retiré dans CARNET cesse donc de jouer au plus tard
// cinq minutes après. Si CARNET ne répond pas, la dernière réponse connue de cette connexion est reprise
// (la connexion elle-même expire au bout de dix heures) ; s'il n'y en a pas, l'appel est refusé : dans le doute, on n'ouvre pas.
//
// Le fichier commence par un tiret bas : Vercel n'en fait pas une adresse publique.

const CARNET = String(process.env.CARNET_URL || "https://carnet-ivory.vercel.app").replace(/\/+$/, "").replace(/\/api\/carnet$/, "") + "/api/carnet";
const FRAIS_MS = 5 * 60 * 1000;     // durée pendant laquelle une réponse de CARNET est reprise sans le réinterroger
const DELAI_MS = 8000;              // attente maximale de CARNET
const MEMOIRE_MAX = 300;
const memoire = new Map();          // connexion → { le, acces, provisoire, personne }

const refus = (code, message, expire) => ({ ok: false, code, message, expire: !!expire });

async function interrogerCarnet(jeton) {
  let r;
  try {
    r = await fetch(CARNET, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "p_moi", jeton }), signal: AbortSignal.timeout(DELAI_MS) });
  } catch { return { muet: true }; }
  if (r.status >= 500) return { muet: true };
  const d = await r.json().catch(() => null);
  if (!r.ok) return { refuse: true };
  if (!d || typeof d !== "object") return { muet: true };
  return { le: Date.now(), acces: d.acces && typeof d.acces === "object" ? d.acces : {}, provisoire: !!d.provisoire, personne: d.personne || null };
}

// Rend { ok: true, niveau, personne } ou { ok: false, code, message, expire }.
// niveauMin : 1 = l'outil est ouvert à la personne ; 2 = elle a en plus la « version payante ».
export async function verifierPersonne(req, outil, niveauMin = 1) {
  const jeton = String((req.headers && req.headers["x-carnet-jeton"]) || "");
  const m = /^p\.(\d+)\.(\d+)\.[A-Za-z0-9_-]+$/.exec(jeton);
  if (!m) return refus(401, "Connexion absente : connectez-vous avec vos initiales.", true);
  if (Number(m[2]) < Date.now()) return refus(401, "Connexion expirée, reconnectez-vous.", true);

  let v = memoire.get(jeton);
  if (!v || Date.now() - v.le > FRAIS_MS) {
    const n = await interrogerCarnet(jeton);
    if (n.refuse) { memoire.delete(jeton); return refus(401, "Connexion expirée, reconnectez-vous.", true); }
    if (n.muet) {
      if (!v) return refus(503, "CARNET ne répond pas : votre accès ne peut pas être vérifié pour l'instant. Réessayez dans un moment.");
    } else {
      v = n;
      if (memoire.size >= MEMOIRE_MAX) memoire.delete(memoire.keys().next().value);
      memoire.set(jeton, v);
    }
  }
  if (v.provisoire) return refus(403, "Votre mot de passe est encore provisoire : choisissez d'abord votre mot de passe personnel dans PLATEFORME.");
  const niveau = Number(v.acces[outil]) || 0;
  if (niveau < 1) return refus(403, "Votre compte n'a pas accès à cet outil : demandez l'ouverture à l'administrateur.");
  if (niveau < niveauMin) return refus(403, "Cette fonction demande la version payante : elle n'est pas ouverte pour votre compte.");
  return { ok: true, niveau, personne: v.personne };
}

// pour les essais hors ligne
export function _viderMemoire() { memoire.clear(); }
