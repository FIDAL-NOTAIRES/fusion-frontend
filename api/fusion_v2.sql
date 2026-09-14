-- FUSION — complément v2 (14/09/2026) : Drive et documents déposés
-- =================================================================
-- À exécuter dans le SQL Editor de Neon, projet neon-fuchsia-pillow, en tant
-- que propriétaire, APRÈS fusion.sql. Idempotent.

-- Identifiants Drive : { racine, societe, nom, cree_le } sur le dossier ;
-- { dossier, ehf, op, opa, ndt } sur chaque groupe (les quatre sous-dossiers).
ALTER TABLE fusion_dossier ADD COLUMN IF NOT EXISTS drive jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE fusion_groupe  ADD COLUMN IF NOT EXISTS drive jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Un seul exemplaire du fichier : celui du Drive. FUSION ne garde que
-- l'empreinte, l'identifiant Drive, le nom composé et le résultat de lecture
-- (même règle que MARTEAU). `type` ∈ EHF | OP | OPA | NDT | AQ.
CREATE TABLE IF NOT EXISTS fusion_document (
  id            serial PRIMARY KEY,
  dossier_id    integer NOT NULL REFERENCES fusion_dossier(id) ON DELETE CASCADE,
  groupe        integer NOT NULL,
  drive_id      text NOT NULL UNIQUE,
  drive_parent  text,
  nom           text NOT NULL,           -- nom composé au plan de nommage
  nom_origine   text,                    -- nom du fichier tel que déposé
  type          text NOT NULL,           -- EHF, OP, OPA, NDT, AQ
  code          text,                    -- 051, 021, 022, 020
  piece         text,                    -- EHF, OP, OPA, NDT, AQ
  date_doc      date,
  date_sure     boolean NOT NULL DEFAULT false,
  empreinte     text,                    -- SHA-256 du fichier déposé
  taille        integer,
  mime          text,
  couche_texte  boolean,                 -- PDF avec texte extractible (passe 1 possible) ou scan (passe 2)
  lecture       jsonb NOT NULL DEFAULT '{}'::jsonb,
  statut        text NOT NULL DEFAULT 'depose',
  depose_le     timestamptz NOT NULL DEFAULT now(),
  modifie_le    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fusion_document_groupe_idx ON fusion_document (dossier_id, groupe);

GRANT SELECT, INSERT, UPDATE, DELETE ON fusion_document TO "matrice_owner";
GRANT USAGE, SELECT ON SEQUENCE fusion_document_id_seq TO "matrice_owner";
