# Douira sur Supabase

Supabase sert uniquement de base PostgreSQL. Comptes, sessions, réservations et paiements restent gérés par
l'API Douira (`api/`) : aucune clé Supabase n'est utilisée par le site ni placée dans le navigateur.

## 1. Adresse de connexion

Supabase > Project Settings > Database > Connection string > **Session pooler** (port **5432**) :

    postgresql://postgres.<ref-projet>:<mot-de-passe>@aws-0-<region>.pooler.supabase.com:5432/postgres

- Pas la « Direct connection » `db.<ref>.supabase.co` : IPv6 seulement, injoignable depuis Render.
- Mot de passe avec des caractères spéciaux : l'encoder (`@` → `%40`, `#` → `%23`, `/` → `%2F`).
- Cette adresse va dans la variable `DATABASE_URL` de Render, jamais dans un fichier du dépôt.

## 2. Création du schéma

Automatique : au démarrage, `server.js` applique les migrations `api/sql/*.sql` (une seule fois chacune).
Pour le faire depuis un ordinateur, avant le déploiement :

    export DATABASE_URL='postgresql://postgres.<ref>:…@…pooler.supabase.com:5432/postgres'
    export DATA_KEY='…'                 # la même valeur que sur Render
    node api/cli.js migrate
    node api/cli.js check

`002_supabase.sql` active la RLS sur toutes les tables et retire les droits des rôles `anon` et
`authenticated` : l'API REST de Supabase ne donne accès à rien. Vous pouvez aussi la couper :
Project Settings > Data API > désactiver.

## 3. Données

- **Administrateur** : créé au premier démarrage à partir de `ADMIN_EMAIL` et `ADMIN_INITIAL_PASSWORD`,
  avec changement obligatoire du mot de passe à la première connexion. En production, sans
  `ADMIN_INITIAL_PASSWORD` (10 caractères min.), aucun compte n'est créé : le journal Render l'indique.
- **Logements** : dans `config.js` (`biens`), pas dans la base.
- **Adresses et codes de porte** : depuis l'administration du site, ou en lot :

      cp api/supabase/seed.example.json api/supabase/seed.json   # ignoré par git
      # compléter seed.json (b1, b2… = id du bien dans config.js précédé de « b »)
      node api/cli.js seed api/supabase/seed.json
      rm api/supabase/seed.json

  Le chiffrement utilise `DATA_KEY` : il faut exactement la clé de Render, sinon le site ne pourra pas les lire
  (`check` le signale).
- **E-mails (SMTP/Resend)** : saisis dans Administration > E-mails, chiffrés en base.

## 4. Sauvegardes

Le plan gratuit de Supabase n'a pas de sauvegarde téléchargeable : utiliser `node api/cli.js backup <dossier>`
(nécessite `pg_dump` 15 ou plus récent).
