// FUSION — GET /api/cadastre?insee=08097&bbox=x1,y1,x2,y2&w=1600&h=1441
// LE PLAN CADASTRAL DE LA DGFiP (18/11/2026, demandé par JFD : « le plan de cadastre de cadastre.gouv », pas celui de l'IGN).
//
// Source : le service de consultation du plan cadastral de la direction générale des finances publiques
// (inspire.cadastre.gouv.fr/scpc/<code INSEE>.wms), le même plan que sur cadastre.gouv.fr — un service par commune.
//
// Pourquoi côté serveur : ce service n'autorise pas la lecture de ses images depuis une autre origine ; or FUSION doit
// relire l'image pour l'embarquer dans le Word de l'acte. La fonction va donc la chercher et la rend telle quelle.
// Elle ne sert QUE ce service : code INSEE, cadre et taille sont contrôlés, rien d'autre n'est relayé.
//
// ÉCHEC EXPLICITE : si le service ne rend pas d'image (commune non vectorisée, service fermé), réponse 502 avec le
// motif ; le navigateur se replie alors sur le plan de l'IGN, puis sur le plan dessiné, et la légende de l'annexe le dit.

export const config = { maxDuration: 30 };

const COUCHES_COMPLETES = "AMORCES_CAD,LIEUDIT,CP.CadastralParcel,SUBFISCAL,CLOTURE,DETAIL_TOPO,HYDRO,VOIE_COMMUNICATION,BU.Building,BORNE_REPERE";
const COUCHES_DE_BASE = "AMORCES_CAD,LIEUDIT,CP.CadastralParcel,DETAIL_TOPO,HYDRO,VOIE_COMMUNICATION,BU.Building,BORNE_REPERE";

async function demander(insee, bbox, w, h, couches) {
  const url = "https://inspire.cadastre.gouv.fr/scpc/" + insee + ".wms?service=WMS&request=GetMap&VERSION=1.3&CRS=EPSG:3857"
    + "&WIDTH=" + w + "&HEIGHT=" + h + "&BBOX=" + bbox.map((v) => v.toFixed(2)).join(",")
    + "&LAYERS=" + couches + "&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE";
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), 8000);
  try {
    const r = await fetch(url, { signal: arret.signal, headers: { "User-Agent": "FUSION (FIDAL Notaires)" } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\//i.test(type)) {
      const texte = await r.text().catch(() => "");
      return { motif: "HTTP " + r.status + " " + type + " " + texte.replace(/\s+/g, " ").slice(0, 200) };
    }
    return { image: Buffer.from(await r.arrayBuffer()), type };
  } catch (e) {
    return { motif: e && e.name === "AbortError" ? "délai dépassé" : String((e && e.message) || e) };
  } finally {
    clearTimeout(minuterie);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ erreur: "Méthode non admise" }); return; }
  const q = req.query || {};
  const insee = String(q.insee || "").toUpperCase();
  if (!/^(\d{2}|2[AB])\d{3}$/.test(insee)) { res.status(400).json({ erreur: "Code INSEE attendu (cinq caractères)." }); return; }
  const bbox = String(q.bbox || "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v)) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]
    || bbox[2] - bbox[0] > 30000 || bbox[3] - bbox[1] > 30000) {
    res.status(400).json({ erreur: "Cadre attendu : xmin,ymin,xmax,ymax en mètres (projection de Mercator), trente kilomètres au plus." }); return;
  }
  const borner = (v, defaut) => Math.max(200, Math.min(2000, parseInt(v, 10) || defaut));
  const w = borner(q.w, 1600), h = borner(q.h, 1200);
  // taille réduite pour le dernier essai : certains services refusent les grandes images
  const k = Math.min(1, 1280 / w, 1024 / h), w2 = Math.round(w * k), h2 = Math.round(h * k);
  const essais = [[w, h, COUCHES_COMPLETES], [w, h, COUCHES_DE_BASE], [w2, h2, COUCHES_DE_BASE]];
  const motifs = [];
  for (const [lw, lh, couches] of essais) {
    const r = await demander(insee, bbox, lw, lh, couches);
    if (r.image) {
      res.setHeader("Content-Type", r.type || "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.status(200).send(r.image);
      return;
    }
    motifs.push(r.motif);
  }
  res.status(502).json({ erreur: "Le service du plan cadastral n'a pas rendu d'image pour la commune " + insee + ".", motifs });
}
