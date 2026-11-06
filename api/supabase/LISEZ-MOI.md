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

## 5. Déploiement du lot en attente (migrations 004 à 026)

Le schéma d'origine s'arrête à `003`. Tout ce qui a été construit depuis — messagerie, services,
destinations, véhicules, pièces justificatives, notes, factures, badges, scans, cartes de membre —
attend d'être appliqué.

**Ces migrations n'effacent rien.** Aucun `DROP TABLE`, aucun `DROP COLUMN`, aucun `DELETE`, aucun
`TRUNCATE` : ce sont des créations de tables et des ajouts de colonnes. Les seules contraintes
supprimées (`conversations_kind_check`, `users_card_tier_check`…) sont reconstruites dans la même
instruction, pour élargir une liste de valeurs admises.

Deux fichiers portent le numéro `016` (`016_revenue.sql` et `016_service_categories.sql`). Ce n'est
pas un problème : le registre `schema_migrations` est tenu **par nom de fichier**, pas par numéro, et
les deux s'appliquent dans l'ordre alphabétique. Ils ne se touchent pas.

### Avant de déployer

    export DATABASE_URL='postgresql://postgres.<ref>:…@…pooler.supabase.com:5432/postgres'
    export DATA_KEY='…'          # exactement la clé de Render
    export CARD_SECRET='…'       # idem — sans elle, les cartes de membre déjà émises changeraient
    node api/cli.js migrate
    node api/cli.js check

`migrate` annonce chaque fichier appliqué. Il est rejouable : un fichier déjà passé est ignoré.
Chaque migration s'exécute dans sa propre transaction — en cas d'échec, elle est annulée entière et
les précédentes restent en place.

### Ce qui reste à saisir ensuite, depuis l'administration

Le code sait traiter ces données mais personne ne les a encore fournies ; en attendant, l'appli
affiche des états de repli honnêtes plutôt que des valeurs inventées.

- **Factures** : raison sociale, adresse, ICE, RC, IF, TVA (réglage `facturation`). Tant qu'ils sont
  absents, ces lignes ne s'impriment pas sur la facture.
- **Cartes de membre** : prix et avantages des quatre niveaux. Sans prix, l'appli écrit « Sur
  demande » — jamais « Gratuit ».
- **Services et véhicules** : photos, position, horaires, ce qui est compris, agence et numéro.
- **Expériences** : date, heure et numéro de l'agence ; trois d'entre elles n'ont pas de photo.

## Certificat TLS de la base (DATABASE_CA)

Le pooler Supabase présente un certificat signé par l'autorité propre de Supabase
(« Supabase Root 2021 CA »), pas par une autorité publique. Pour que le serveur
authentifie VRAIMENT la base (et pas seulement chiffre la liaison), cette racine est
versionnée ici : `api/supabase/supabase-ca.crt` (certificat public, valable jusqu'en 2031).

- Locale et Render : `DATABASE_CA=api/supabase/supabase-ca.crt` (déjà dans `render.yaml`
  et `.env.example`). Sans cette variable, la connexion reste chiffrée mais le code
  prévient au démarrage que l'identité du serveur n'est pas vérifiée.
- Empreinte SHA-256 de la racine (à comparer au certificat publié par Supabase si besoin) :
  `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
