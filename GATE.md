# GATE — porte de qualité Douira

État au 1er novembre 2026. Ce fichier est le point de passage : **aucune
livraison ne franchit cette porte tant que les contrôles de la section 2 ne
passent pas tous.**

Lecteur visé : la personne — ou l'agent — qui reprend le travail. Il dit ce qui
est vrai, ce qui est vérifié, ce qui ne l'est pas, et ce qu'il ne faut pas
faire.

**Aucun secret dans ce fichier.** Tout vit dans `api/.env`, ignoré par git.

---

## 1. Ce qui tourne

| Pièce | Où | État |
|---|---|---|
| Base de données | Supabase, projet `cdqlvlwdmlrpyviwxqtj`, région eu-west-3 | **32 tables, 29 migrations, 74 index, 32/32 verrouillées (RLS)** |
| Connexion | « Session pooler » `aws-1-eu-west-3.pooler.supabase.com:5432` | la connexion directe `db.<ref>.supabase.co` n'existe **qu'en IPv6** : inutilisable depuis Render |
| API | `node server.js` sur ce Mac, port 10000 | lit `api/.env` |
| Tunnel public | Cloudflare « quick tunnel » | éphémère : meurt avec le processus, l'URL change à chaque relance |
| Appli | Expo SDK 58, Metro port 8081 | `Douira.ma.appli/.env` → `EXPO_PUBLIC_API_URL` pointe sur le tunnel |
| Catalogue | 6 logements, 10 expériences, 2 destinations, 4 cartes | importés de `config.js` — **contenu réel, pas de données inventées** |
| Services / véhicules | vides | les jeux de démonstration ont été retirés à la demande |

### Relancer après un redémarrage du Mac

```sh
brew services start postgresql@17           # seulement si l'on veut la base LOCALE
/private/tmp/.../scratchpad/run-api.sh &    # API, lit api/.env (→ Supabase)
cloudflared tunnel --url http://127.0.0.1:10000 --no-autoupdate &
cd ~/Documents/Douira.ma.appli && npx expo start --clear --port 8081
```

La nouvelle URL du tunnel doit être recopiée dans `Douira.ma.appli/.env`, puis
Metro relancé (`--clear`) : `EXPO_PUBLIC_*` est figée à la construction du
paquet, pas lue à l'exécution.

---

## 2. Les contrôles de la porte

Tous doivent passer. Les chiffres sont ceux constatés le 1er novembre 2026.

| # | Commande | Attendu | Constaté le 1er nov. |
|---|---|---|---|
| G1 | `cd api && node --test test/` | **316 / 316**, 0 échec | 316 / 316 — passe |
| G2 | `cd Douira.ma.appli && npx tsc --noEmit` | aucune sortie | aucune sortie — passe |
| G3 | `grep -rn "VERIF" Douira.ma.appli/src/` | aucune sortie (aucune sonde oubliée) | aucune sortie — passe |
| G4 | `cd api && ADMIN_EMAIL=… ADMIN_PASSWORD=… node audit-securite.mjs` | **55 contrôles**, 0 `ÉCHEC`, 0 `SAUTÉ`, sortie 0 | 45 passés, **4 échecs, 6 non exécutés** — **ÉCHOUE**, cause § 6.2 |
| G5 | `cd api && npm audit --omit=dev` | 0 vulnérabilité | 0 vulnérabilité — passe |
| G6 | SQL : toute table de `public` a `relrowsecurity = true` | 32 / 32 | 32 / 32 — passe |
| G7 | `python3 -c "import pglast; pglast.parse_sql(open('api/sql/0NN_*.sql').read())"` | sur chaque migration nouvelle | sans objet (aucune migration ajoutée) |
| G8 | capture d'écran de l'écran modifié, relue | obligatoire avant d'affirmer qu'un écran fonctionne | — |
| G9 | `cd Douira.ma.appli && npm test` | **10 / 10**, 0 échec | 10 / 10 — passe |

`node` n'est pas sur le `PATH` par défaut de ce Mac : `export PATH="/opt/homebrew/bin:$PATH"`.

**G4 ne passe pas, et ce n'est pas un défaut de code.** Les quatre échecs et les
six contrôles non exécutés viennent tous d'une seule cause : le mot de passe
initial de l'administrateur n'a pas été changé, donc toutes les routes
d'administration répondent `403 Changez votre mot de passe initial pour
continuer.` La pièce d'identité du client d'essai ne peut pas être vérifiée,
donc aucune réservation ne peut être créée, donc les contrôles qui en dépendent
tombent ou ne s'exécutent pas. Cette première connexion appartient au titulaire
du compte (§ 6.2) : **G4 ne peut pas passer avant qu'elle soit faite.** Le
script le dit en tête de sortie.

Parmi les six non exécutés, deux comptent plus que les autres : « le prix
envoyé par le client est IGNORÉ » et « le montant à payer suit le devis ». Le
§ 4 range le prix imposé par le client parmi ce qui est vérifié ; depuis la base
actuelle, **il ne l'est pas** — il n'est pas exercé du tout.

Avant la série, remettre à zéro les seuls compteurs de la série, pour ne pas
effacer ceux du trafic réel :

```sql
DELETE FROM rate_limits WHERE key LIKE '%:127.0.0.1' OR key LIKE 'login:email:%';
```

Sans cela la limitation de débit fausse les résultats : la fenêtre va jusqu'à
une heure, et une série précédente suffit à faire répondre 429.

Le script de G4 vit désormais dans le dépôt (`api/audit-securite.mjs`). Il ne
vivait que dans un dossier temporaire de session, qui disparaît sans prévenir :
un contrôle de la porte qui n'est pas dans le dépôt n'existe que le temps d'une
conversation.

---

## 3. Règles de travail, apprises à leurs dépens

1. **Ne jamais affirmer qu'un écran fonctionne sans l'avoir vu.** Les captures
   se prennent après un **redémarrage à froid** d'Expo Go : le rechargement à
   chaud ment régulièrement.
2. **Aucune donnée inventée.** Pas de prix, pas de note, pas d'avis, pas
   d'identifiant légal. Un prix non fixé s'écrit « Sur demande », jamais
   « Gratuit ».
3. **Aucun emoji dans l'interface.** Chaque marqueur visuel se dessine dans
   `src/components/icons.tsx`.
4. **Vide et panne ne se confondent pas.** Un écran qui ne peut pas charger le
   dit et propose « Réessayer » ; il n'affiche pas « aucun élément ».
5. **Ne jamais supprimer un test qui échoue** pour verdir la série. Déterminer
   s'il révèle un défaut, une hypothèse de test fausse ou un problème
   d'environnement.
6. **`npm audit fix --force` est interdit côté appli** : il rétrograderait Expo
   de 58 à 51. Les 15 avis restants sont dans la chaîne de construction, pas
   dans le code embarqué.
7. **Les sondes de vérification se marquent `// VERIF`** et se retirent avant
   de conclure (G3).

---

## 4. Ce qui est vérifié, et comment

**Par exécution réelle contre un serveur et une base** : inscription,
connexion, changement de mot de passe imposé, dépôt de pièce, vérification par
l'équipe, devis, réservation, blocage des dates, annulation, facture,
vérification du visage (humaine et automatique), et 30 contrôles de sécurité —
IDOR, élévation de privilèges, CSRF, origine, prix imposé par le client,
réservations simultanées, webhooks non signés, force brute, fuite
d'informations, en-têtes.

**Par capture d'écran sur simulateur iOS** : écrans d'administration, mode
clair et sombre sur treize écrans, parcours de vérification d'identité, cartes.

**Non vérifié — à faire par qui reprend :**

| Point | Pourquoi | Comment le débloquer |
|---|---|---|
| L'appli sur Android | **le téléphone n'est pas branché.** `adb devices` ne liste rien, et `system_profiler SPUSBDataType` ne renvoie aucune ligne : le bus USB est vide. Ce n'est donc pas un réglage de débogage à activer, c'est un câble à brancher (ou un câble qui ne transporte que le courant) | brancher le téléphone, puis Paramètres → À propos → Informations logiciel → 7 tapotements sur « Numéro de version » → Options de développement → **Débogage USB**, puis accepter la fenêtre sur le téléphone. Vérifier avec `adb devices` |
| Pastilles sur **les quatre cartes** Android | corrigées, **gardées par G9**, mais toujours pas vues sur un écran Android. Les deux cartes de prix, plus la carte des séjours et l'ajout à une collection, corrigés le 1er nov. (§ 5 bis) | `src/components/capture-marker.tsx` — voir § 5 et § 5 bis. G9 garde la forme du code ; seul un téléphone dit si la pastille s'affiche |
| Parcours tactiles | aucun outil de frappe sur simulateur, et pas de téléphone | `adb shell input tap` une fois le téléphone branché |
| Performance sous charge | hors de portée | environnement dédié |
| Restauration d'une sauvegarde | jamais éprouvée | `node api/cli.js backup`, puis restaurer sur une base séparée |
| Première connexion administrateur | appartient au titulaire du compte | voir § 6 |

---

## 5. Défauts corrigés le 1er novembre, à ne pas réintroduire

| Défaut | Fichier | Ce qui le garde fermé |
|---|---|---|
| Le catalogue publie `1`, le serveur range `b1` : **aucune réservation possible**, calendrier faussement libre | `api/lib/catalog.js` | `trouverBien()` + 8 tests dans `api/test/listing-id.test.js` |
| `INSERT` des services : 11 colonnes pour 17 valeurs — **aucun service enregistrable** | `api/lib/services.js` | **6 tests dans `api/test/services-insert.test.js`** : une fausse base retient l'ordre envoyé et chaque colonne est comparée à sa valeur, plus un balayage des 33 `INSERT` de `lib/`. Réintroduit, le défaut rend la même phrase qu'à l'origine : « 11 colonnes pour 17 valeurs » |
| 4 tables sans verrou de lecture directe (`invoices`, `scans`, `card_offers`, `service_categories`) | `api/sql/028_*.sql` | G6 |
| Erreurs métier rendues en 500 au lieu de 403/404/409 | `api/index.js`, gestionnaire central | G4 |
| Pastilles de prix invisibles sur Android jusqu'au toucher (`tracksViewChanges`) | `src/components/capture-marker.tsx` — **tous** les marqueurs y passent désormais | **10 tests dans `Douira.ma.appli/test/capture-marker.test.mjs`** (G9) : la capture ne peut plus être figée par un littéral, part allumée, s'éteint après un délai non nul, se rallume sur l'apparence, aucune apparence ne peut être constante, et **aucun fichier de `src/` ne peut construire un `<Marker>` brut ni régler `tracksViewChanges`**. Neuf mutations essayées, neuf attrapées, dont la remise des deux défauts du § 5 bis. **Reste à confirmer sur appareil réel** : ces tests gardent la forme du code, pas le pixel |
| Boutons flottants invisibles en mode sombre | `theme.ts`, jeton `overlay` | capture en mode sombre |
| Étoiles arrondies : 4,5 affichait cinq étoiles pleines | `src/components/stars.tsx` | capture |

---

## 5 bis. Défauts trouvés le 1er novembre, corrigés mais PAS ENCORE VUS

Le défaut `tracksViewChanges` n'avait été corrigé que dans `price-marker.tsx`.
Deux autres marqueurs portaient une vue personnalisée et retombaient dans le
même piège :

| Où | Ce qui était écrit | Pourquoi c'était le même défaut |
|---|---|---|
| `src/app/trips-map.tsx` | `tracksViewChanges={false}` | Écrit en dur : la capture a lieu avant que la vue soit mesurée et colle une image vide. Les pastilles de la carte des séjours risquaient d'être invisibles sur Android |
| `src/app/collection/ajouter/[id].tsx` | `tracksViewChanges={actif \|\| ajoute}` | Valait `false` au premier rendu pour tout marqueur ni choisi ni déjà ajouté — c'est-à-dire le cas courant, et c'est le premier rendu qui pose le problème |

**La correction vit maintenant à un seul endroit**, `src/components/capture-marker.tsx`.
Le défaut était né d'une recopie : le même marqueur écrit sur plusieurs écrans,
donc le même oubli plusieurs fois, et une correction appliquée à un seul. Tout
marqueur portant une vue personnalisée passe désormais par `CaptureMarker`, qui
tient la fenêtre de capture ; l'appelant ne déclare que son `apparence`, la
chaîne dont dépend son aspect. Les trois sites ont été migrés —
`price-marker.tsx`, `trips-map.tsx`, `collection/ajouter/[id].tsx` — et G9
interdit qu'un `<Marker>` brut réapparaisse dans `src/`.

**Ce qui reste dû : les voir.** Ces deux écrans n'ont pas été ouverts sur un
téléphone, ni même sur simulateur : la correction est établie par le mécanisme
et gardée par G9, pas par observation. Le § 3.1 s'applique — ne pas affirmer
que ces cartes fonctionnent avant de les avoir vues. À regarder en priorité au
prochain branchement : **carte des séjours** et **ajout à une collection**, en
plus des deux cartes de prix.

---

## 6. Ce qui attend une décision humaine

1. **`douira.ma` ne sert pas la plateforme.** Le DNS pointe sur un hébergement
   mutualisé qui redirige vers un autre site, et le certificat TLS appartient à
   un troisième domaine. Rien ne peut être mis en production avant que ce point
   soit réglé. Hors du code.
2. **Première connexion administrateur.** Le compte est créé avec un mot de
   passe initial et le changement est imposé — il bloque tout le reste tant
   qu'il n'est pas fait. Cette première connexion appartient au titulaire.
   **C'est aujourd'hui le seul obstacle à G4** : 4 échecs et 6 contrôles non
   exécutés, tous de cette cause. Une fois le mot de passe changé, relancer G4
   avec `ADMIN_PASSWORD` au nouveau mot de passe. Si l'on veut que G4 passe
   sans dépendre de ce compte, il faudra donner à la série son propre
   administrateur jetable — un contrôle de la porte ne devrait pas avoir
   besoin du compte du titulaire.
3. **Faire tourner les secrets.** Le mot de passe de la base et les clés du
   projet ont transité par une conversation : à changer depuis le tableau de
   bord Supabase une fois l'installation stabilisée, puis à reporter dans
   `api/.env`. **`DATA_KEY` fait exception : elle ne se change pas** — perdue,
   les adresses, codes d'accès et pièces déjà chiffrés deviennent illisibles.
   À sauvegarder hors de cette machine.
4. **Déploiement.** `render.yaml` décrit le service ; rien n'est déployé. La
   démonstration passe par un tunnel éphémère.
5. **Vérification d'identité** : le robot compare des visages mais ne détecte
   pas la vivacité. Prestataire spécialisé, AIPD et autorisation CNDP — voir
   `api/docs/VERIFICATION-IDENTITE.md`.

---

## 7. Où trouver le reste

| Document | Contenu |
|---|---|
| `api/audit-securite.mjs` | le contrôle G4 lui-même : 55 contrôles de sécurité contre un serveur local |
| `api/test/services-insert.test.js` | garde l'`INSERT` des services (§ 5) |
| `Douira.ma.appli/src/components/capture-marker.tsx` | la fenêtre de capture d'Android, expliquée ; tout marqueur à vue personnalisée passe par là |
| `Douira.ma.appli/test/capture-marker.test.mjs` | garde les marqueurs de carte (§ 5 et § 5 bis), lancé par `npm test` |
| `api/docs/AUDIT-2026-11-01.md` | audit complet : défauts, sécurité, ce qui n'a pas pu être vérifié |
| `api/docs/VERIFICATION-IDENTITE.md` | conception de la vérification d'identité, coûts, conformité |
| `api/supabase/LISEZ-MOI.md` | déploiement de la base et des migrations |
| `api/.env.example` | toutes les variables, commentées |
