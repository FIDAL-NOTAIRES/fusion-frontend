-- FUSION — tables de persistance
-- ====================================
-- À exécuter dans le SQL Editor de Neon, projet neon-fuchsia-pillow, EN TANT QUE
-- PROPRIÉTAIRE (rôle par défaut de la console), en une seule fois.
--
-- Piège connu de la suite (09/09/2026) : sans le GRANT ci-dessous, la première
-- écriture de l'outil échoue en « permission denied for schema public ».
-- Il est idempotent : le rejouer ne casse rien.
--
-- Base PARTAGÉE avec MATRICE, MARTEAU et PARTAGE AMIABLE : toutes les tables
-- de FUSION portent le préfixe fusion_. Ne jamais toucher aux autres.

GRANT USAGE, CREATE ON SCHEMA public TO "matrice_owner";

-- ---------------------------------------------------------------------------
-- Une société traitée = un dossier. Le SIREN est la clé métier : un seul
-- dossier FUSION par société. `etat` porte ce qui n'est ni parcelle ni groupe :
-- rapprochements écartés, seuils choisis, sans-géométrie du dernier relevé.
CREATE TABLE IF NOT EXISTS fusion_dossier (
  id            serial PRIMARY KEY,
  siren         text NOT NULL UNIQUE,
  denomination  text,
  millesime     text,
  etat          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cree_le       timestamptz NOT NULL DEFAULT now(),
  modifie_le    timestamptz NOT NULL DEFAULT now()
);

-- Les groupes (unités foncières retenues). `manuel` = touché par l'utilisateur :
-- la géométrie ne fait plus foi dessus, on ne le recalcule jamais d'office.
CREATE TABLE IF NOT EXISTS fusion_groupe (
  dossier_id    integer NOT NULL REFERENCES fusion_dossier(id) ON DELETE CASCADE,
  numero        integer NOT NULL,
  manuel        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (dossier_id, numero)
);

-- Les parcelles du relevé, avec leur contour tel que REDPAR l'a servi : le
-- dossier se rouvre depuis n'importe quel poste sans repasser par Etalab.
-- `groupe` = numéro du groupe d'appartenance (NULL = sans géométrie, non groupée).
CREATE TABLE IF NOT EXISTS fusion_parcelle (
  dossier_id    integer NOT NULL REFERENCES fusion_dossier(id) ON DELETE CASCADE,
  idu           text NOT NULL,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb,
  contour       jsonb,
  groupe        integer,
  PRIMARY KEY (dossier_id, idu)
);
CREATE INDEX IF NOT EXISTS fusion_parcelle_groupe_idx ON fusion_parcelle (dossier_id, groupe);

-- Journal des mouvements : qui a fait quoi sur le découpage, dans l'ordre.
-- Ne journaliser que ce qui engage (fusion, détachement, réinitialisation).
CREATE TABLE IF NOT EXISTS fusion_journal (
  id            bigserial PRIMARY KEY,
  dossier_id    integer NOT NULL REFERENCES fusion_dossier(id) ON DELETE CASCADE,
  quand         timestamptz NOT NULL DEFAULT now(),
  quoi          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fusion_journal_dossier_idx ON fusion_journal (dossier_id, quand);

-- Droits du rôle applicatif sur ce que le propriétaire vient de créer.
GRANT SELECT, INSERT, UPDATE, DELETE ON fusion_dossier, fusion_groupe, fusion_parcelle, fusion_journal TO "matrice_owner";
GRANT USAGE, SELECT ON SEQUENCE fusion_dossier_id_seq, fusion_journal_id_seq TO "matrice_owner";
