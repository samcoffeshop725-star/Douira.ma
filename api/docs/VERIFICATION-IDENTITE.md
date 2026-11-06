# Vérification d'identité et comparaison faciale — conception

*Document de conception. Rien de ce qui suit n'est implémenté : il décrit ce qu'il
faudrait construire, ce que cela coûte, et ce qu'il reste à décider.*

Rédigé le 1er novembre 2026, pour Douira (appli Expo + API Node) : l'équipe qui
construira la fonctionnalité, et quiconque devra en discuter le budget ou la
conformité.

---

## 0. Ce qui existe déjà — le vrai point de départ

Le brief suppose une page blanche. Elle ne l'est pas. Douira vérifie **déjà**
les pièces d'identité, et cette brique conditionne déjà les réservations :

| Brique existante | Où | Ce qu'elle fait |
|---|---|---|
| Dépôt de pièce | `src/app/account/documents.tsx` → `POST /api/me/documents` | CIN, passeport ou permis : numéro + photo, 2 Mo max, JPEG/PNG/WebP/PDF |
| Stockage chiffré | `api/lib/documents.js`, table `client_documents` | Numéro et image chiffrés avec `DATA_KEY` ; image effacée automatiquement 90 jours après le séjour (`KEEP_DAYS`) |
| Revue humaine | `src/app/documents-review.tsx` → `GET /api/admin/documents` | L'équipe habilitée voit la pièce et décide `verified` / `rejected` avec un motif |
| Accès restreint | `documents.fileFor()` | L'image en clair ne sort **que** pour une pièce en attente, pièce par pièce, et la consultation est tracée |
| Blocage métier | `documents.missing()` | Pas de réservation sans pièce d'identité vérifiée ; permis exigé en plus si un véhicule est loué |

**Conséquence sur la conception.** Ce qu'il faut ajouter n'est pas « un système
de vérification d'identité » : c'est **(a)** une preuve que le document est
authentique et non une photocopie retouchée, **(b)** un selfie avec détection de
vivacité, **(c)** la comparaison de ce selfie avec le portrait du document. La
revue humaine existante devient le **recours**, pas le mode nominal — ce qui
tombe bien, car le RGPD l'exige (§ 5.6).

---

## 1. Hypothèses posées

Le brief dit que la pile et le public ne sont pas connus. La pile, elle, l'est —
je la rappelle plutôt que de l'inventer. Les hypothèses portent sur le reste.

| # | Hypothèse | Comment l'ajuster |
|---|---|---|
| H1 | **Pile** (fait, pas hypothèse) : Expo SDK 58 / React Native 0.88 (New Architecture), expo-router, TypeScript ; API Node sans framework, PostgreSQL (Supabase), hébergement Render ; session par cookie `HttpOnly` + `X-CSRF-Token` ; `expo-camera`, `react-native-nfc-manager` et `expo-screen-capture` déjà installés | — |
| H2 | **Volumes** : moins de 500 vérifications par mois la première année | Au-delà de ~5 000/mois, le coût unitaire d'un prestataire pèse et l'option « briques assemblées » (§ 3b) redevient discutable |
| H3 | **Public** : voyageurs européens majoritaires, plus des résidents marocains et sénégalais. Documents à couvrir : passeports (tous pays), CIN marocaine, CNI sénégalaise, permis de conduire | Si le public devient majoritairement local, la couverture des documents africains devient le critère n° 1 du choix de prestataire — et c'est là que les écarts entre fournisseurs sont les plus grands |
| H4 | **Équipe** : une personne au développement, pas de juriste ni de responsable conformité interne | L'AIPD (§ 5.5) et le dossier CNDP demandent un appui externe. Ce n'est pas optionnel |
| H5 | **Plateformes** : iOS d'abord, Android ensuite | — |
| H6 | **Pas d'obligation réglementaire de KYC** : Douira n'est ni banque ni PSAN. L'obligation marocaine est la *déclaration des voyageurs* (fiche de police), qui demande une identité, pas une biométrie | Si Douira encaisse pour le compte de tiers à grande échelle, un conseil juridique sur le statut d'intermédiaire de paiement s'impose |

**H6 est la plus importante, et elle change le périmètre.** Voir § 2.1.

---

## 2. Architecture recommandée

### 2.1 D'abord : à qui imposer ce parcours ?

Avant l'architecture, une question de produit que le brief ne pose pas. Soumettre
**toute inscription** à une vérification biométrique coûte cher (§ 3), fait
abandonner des clients, et crée un traitement de données sensibles à grande
échelle — le cas qui déclenche le plus d'obligations RGPD.

Recommandation : **déclencher la vérification sur l'acte, pas sur l'inscription.**

| Situation | Niveau exigé |
|---|---|
| Inscription, navigation, mise en favori | Rien |
| Réservation d'un logement | Pièce d'identité vérifiée (**l'existant suffit**) |
| **Location d'un véhicule** | Pièce + permis + **selfie et comparaison faciale** |
| Séjour au-dessus d'un seuil de valeur, à fixer | Idem véhicule |
| Signal de fraude (paiement contesté, pièce déjà vue sur un autre compte) | Idem, imposé par l'équipe |

La raison est concrète : le risque qui justifie la biométrie, c'est **remettre
les clés d'une voiture à quelqu'un qui présente le permis d'un autre**. Pour une
nuit en appartement, l'obligation légale est satisfaite par le document seul.
Ce ciblage divise le coût par dix et réduit d'autant l'exposition réglementaire.

### 2.2 Où se fait la comparaison faciale — et pourquoi pas sur l'appareil

**Décision : la comparaison se fait côté serveur (ou chez le prestataire).
Jamais sur l'appareil.**

Le brief dit « sur le modèle de Face ID ». C'est la bonne intuition d'usage et la
mauvaise analogie technique, pour trois raisons :

1. **Face ID ne compare pas un visage à un document.** Il compare un visage à un
   gabarit enregistré par le propriétaire du téléphone, scellé dans la Secure
   Enclave. Il répond à « est-ce la personne qui a configuré ce téléphone ? »,
   jamais à « est-ce le titulaire de ce passeport ? ».
2. **Un verdict calculé sur l'appareil est un verdict que l'attaquant écrit.**
   Sur un téléphone débridé ou une appli réinstrumentée, `{"match": true}` coûte
   cinq minutes. Tout ce qui décide doit être hors de portée de celui qu'on
   vérifie — c'est la même règle qui fait que `documents.fileFor()` tourne sur le
   serveur et pas dans l'appli.
3. **Le modèle embarqué se fige.** Les attaques par deepfake progressent de mois
   en mois ; un prestataire met ses modèles à jour en continu, un modèle embarqué
   attend la prochaine version de l'app sur les stores.

**Face ID garde un rôle légitime, mais un autre** : reverrouiller l'accès à
l'appli ou à la carte de membre (`expo-local-authentication`). C'est du confort
local, pas de la preuve d'identité. À ne pas confondre dans les écrans ni dans
les textes.

### 2.3 Composants et responsabilités

```
┌─ Appli Expo ───────────────────────────────────────────────┐
│  SDK du prestataire (vue native)                           │
│   · capture guidée du document (cadrage, netteté, reflets) │
│   · lecture NFC de la puce si passeport (§ 3.4)            │
│   · selfie + vivacité (défis pilotés par le prestataire)   │
│  N'envoie JAMAIS de verdict à l'API Douira.                │
└───────────┬────────────────────────────────┬───────────────┘
            │ 1. demande un jeton            │ 3. envoie les captures
            ▼                                ▼  (direct au prestataire,
┌─ API Douira (Node) ─────────────┐   ┌──── sans transiter par nous)
│ POST /api/me/kyc/session        │   │
│  · vérifie la session + CSRF    │   │  ┌─ Prestataire KYC ──────────┐
│  · appelle le prestataire       │──────▶│ OCR + MRZ + authenticité  │
│  · renvoie un jeton court       │   │  │ vivacité (PAD certifié)    │
│                                 │   │  │ comparaison faciale        │
│ POST /api/webhooks/kyc  ◀───────────────│ webhook signé             │
│  · vérifie la signature         │   │  └────────────────────────────┘
│  · écrit le VERDICT en base     │   │
│  · ne stocke ni image ni gabarit│   │
│                                 │   │
│ GET /api/me/kyc  → état lisible │   │
└─────────────────────────────────┘   │
            │
            ▼
   PostgreSQL : table `kyc_checks` (verdict, motif, horodatage,
   référence prestataire). Aucune donnée biométrique chez nous.
```

**Le principe qui tient tout** : l'appli obtient un jeton, le prestataire rend un
verdict **au serveur** par webhook signé, et le serveur seul écrit en base. L'appli
ne fait que montrer l'état. Un client qui rejouerait l'écran de succès n'obtiendrait
rien, parce que le succès ne vient pas de lui.

### 2.4 Schéma de données proposé

Deux migrations, dans la continuité de l'existant (`api/sql/0NN_*.sql`, rejouées
au démarrage et indexées par nom de fichier) :

```sql
-- Vérifications biométriques. On garde la DÉCISION, pas la mesure.
CREATE TABLE IF NOT EXISTS kyc_checks (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,                 -- 'sumsub', 'veriff'…
  provider_ref text NOT NULL,                 -- identifiant de session chez eux
  status       text NOT NULL                  -- 'pending'|'passed'|'failed'|'review'
               CHECK (status IN ('pending','passed','failed','review')),
  reason       text NOT NULL DEFAULT '',      -- motif lisible, jamais un score brut
  doc_kind     text NOT NULL DEFAULT '',      -- 'passeport'|'cin'|'permis'
  attempt      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE INDEX IF NOT EXISTS kyc_checks_user ON kyc_checks (user_id, created_at DESC);
```

Ce qui **n'y est pas**, volontairement : aucune image, aucun gabarit facial,
aucun score de similarité. Le score est une donnée biométrique dérivée ; le
conserver nous ferait porter la charge sans nous apporter un usage. Le motif
stocké est un libellé (« visage non concordant », « document illisible »).

---

## 3. Choix technologiques

### 3.1 Tableau comparatif

| Option | Coût | Précision / robustesse | Latence | Maintenance | Déploiement | Verdict |
|---|---|---|---|---|---|---|
| **A. Prestataire KYC tout-en-un**<br>Sumsub, Veriff, Onfido (Entrust), Didit, Regula | ~1 à 2 $ par vérification au tarif public ; minimums mensuels fréquents (~50 à 150 $) ; Onfido = contrat annuel négocié. **À 300 vérif./mois : 300 à 600 $/mois** | La meilleure disponible : vivacité certifiée iBeta (PAD niveau 1 et 2), détection d'injection vidéo, couverture de milliers de documents, modèles mis à jour en continu | 5 à 60 s selon le fournisseur et le mode | Quasi nulle côté Douira : le fournisseur suit les nouvelles attaques | **SDK natif ⇒ development build EAS obligatoire** (§ 3.3) | ✅ **Recommandé pour le MVP** |
| **B. Briques cloud assemblées**<br>AWS Rekognition `CompareFaces` + `Face Liveness`, OCR/MRZ séparé | ~0,001 $ par comparaison, ~0,015 $ par contrôle de vivacité (chiffres tiers, à confirmer chez AWS). **À 300 vérif./mois : quelques dollars** | Comparaison faciale excellente. **Trou béant : rien ne vérifie l'authenticité du document.** Un passeport contrefait passe | 2 à 5 s | À votre charge : orchestration, échecs, mises à jour, veille anti-deepfake | SDK AWS Amplify côté client, également une build native | Envisageable **plus tard**, quand les volumes le justifient et si l'authenticité est couverte autrement (NFC, § 3.4) |
| **C. Open source auto-hébergé**<br>InsightFace / ArcFace + vivacité maison | Serveur GPU : 50 à 300 $/mois, **plus** le temps de développement | Comparaison faciale : très bonne. **Vivacité maison : le maillon qui casse.** C'est un domaine adverse, mis à l'épreuve par des gens dont c'est le métier | Maîtrisée | Lourde et permanente | Hors Render : il faut une machine avec GPU | ❌ **Déconseillé.** Perdre sur la vivacité, c'est perdre tout le dispositif, et c'est vous qui porterez la responsabilité du faux positif |
| **D. Lecture NFC de la puce (eMRTD)**<br>`react-native-nfc-manager`, déjà installé | Gratuit, hors développement | **La preuve d'authenticité la plus forte qui existe** : la puce est signée par l'État émetteur et contient le portrait officiel en haute définition. Ne couvre que les passeports et titres à puce — ni CIN marocaine ancienne, ni permis | 5 à 15 s de lecture | Faible une fois construit, mais construction délicate (BAC/PACE, chaîne de certificats) | iOS 13+ et Android NFC | 🔸 **Complément, pas socle.** À viser en phase 3 |

### 3.2 Ce que je recommande, et pourquoi

**Un prestataire tout-en-un (option A) pour le MVP.** Le raisonnement tient en
trois lignes :

- À 300 vérifications par mois, l'écart de coût entre A et B est de l'ordre de
  **500 $/mois**. L'écart de temps de développement est de **plusieurs semaines**,
  puis d'une veille permanente. Pour une personne seule, A gagne largement.
- La vivacité et la détection d'injection vidéo sont des **domaines adverses**.
  Ce que vous écrivez aujourd'hui est contourné dans six mois, et vous ne le
  saurez qu'en lisant un litige.
- Un prestataire vous donne le **PAD certifié iBeta**, qui est l'argument que
  vous produirez si un client conteste une décision ou une location.

**Lequel ?** Je ne peux pas trancher à votre place sans deux informations que
vous seule pouvez obtenir : la **couverture réelle de la CIN marocaine et de la
CNI sénégalaise**, et les **tarifs négociés à votre volume**. Les chiffres
publics sont approximatifs et vieillissent vite. Le critère n° 1 est la
couverture des documents de vos deux marchés — un fournisseur excellent sur les
passeports européens et faible sur le Maghreb vous renverra vos clients locaux en
revue manuelle, ce qui annule le bénéfice.

### 3.3 La contrainte Expo, à ne pas découvrir en route

Tous les SDK KYC embarquent du code natif. **Expo Go ne pourra plus lancer
l'appli** une fois le SDK ajouté. Il faut passer à un *development build* (EAS),
ce qui change votre boucle de travail quotidienne : plus de rechargement
instantané via Expo Go, une build à refaire à chaque changement natif.

Ce n'est pas bloquant, mais c'est à faire **avant** d'intégrer quoi que ce soit,
et à budgéter (1 à 2 jours, plus les comptes développeur Apple et Google).

Variante à considérer : les parcours **web redirigés** (le client est envoyé vers
une page hébergée par le prestataire, puis revient dans l'appli). Plus lents et
moins élégants, mais ils évitent entièrement le natif. Utile pour tester le
produit avant d'engager la refonte de la chaîne de build.

### 3.4 NFC : l'atout que vous avez déjà sous la main

`react-native-nfc-manager` est **déjà dans vos dépendances**. Lire la puce d'un
passeport biométrique donne le portrait officiel signé par l'État — infalsifiable
sans la clé de cet État. Comparer le selfie à **ce** portrait-là, plutôt qu'à une
photo de la page papier, change la nature de la preuve.

À garder pour une phase ultérieure (la lecture BAC/PACE est pénible à
implémenter), mais c'est la bonne direction à long terme, et elle réduira la
facture du prestataire.

---

## 4. Parcours utilisateur

### 4.1 Le flux nominal

| # | Écran | Ce qui se passe | Durée visée |
|---|---|---|---|
| 1 | **Pourquoi** | « Pour louer un véhicule, la loi nous demande de vérifier que le permis est bien le vôtre. » Dit avant de demander quoi que ce soit — personne ne tend son passeport sans savoir pourquoi | — |
| 2 | **Consentement** | Case **non pré-cochée** : traitement des données biométriques, finalité, conservation, destinataire. Horodaté et conservé (§ 5.3) | — |
| 3 | **Choix du document** | Passeport / CIN / permis, selon ce qui est exigé | — |
| 4 | **Capture recto** | Cadrage guidé, contrôle immédiat de netteté, reflets, bords coupés. On refuse **sur place** plutôt qu'après coup | 10 s |
| 5 | **Capture verso** | Si le document en a un | 10 s |
| 6 | **Puce NFC** (phase 3) | « Posez votre passeport contre le téléphone » | 10 s |
| 7 | **Selfie avec vivacité** | Défis **choisis par le serveur** (tourner la tête, approcher). L'ordre ne doit jamais être prévisible : sinon on enregistre une vidéo à l'avance | 15 s |
| 8 | **Analyse** | Écran d'attente honnête : « Quelques secondes ». Si plus de 30 s : « Nous vous préviendrons, vous pouvez fermer l'appli » | 5–60 s |
| 9 | **Résultat** | Accepté → la réservation reprend là où elle s'était arrêtée. Sinon → § 4.2 | — |

### 4.2 Les échecs, et ce qu'on dit

Règle de rédaction : **dire ce qui s'est passé et ce qu'il faut faire**, sans
jamais apprendre à un fraudeur ce qui l'a trahi.

| Cas | Message au client | Suite |
|---|---|---|
| Photo floue, reflet, bord coupé | « La photo est trop floue pour être lue. Posez le document à plat, sans reflet. » | Nouvelle tentative immédiate, non décomptée |
| Document non reconnu | « Nous ne reconnaissons pas ce document. Vérifiez qu'il s'agit bien d'un passeport, d'une CIN ou d'un permis en cours de validité. » | Nouvelle tentative |
| Document expiré | « Ce document a expiré le JJ/MM/AAAA. Il nous en faut un en cours de validité. » | Pas de nouvelle tentative avec le même document |
| Vivacité échouée | « Nous n'avons pas pu confirmer que vous étiez devant l'appareil. Placez-vous dans un endroit éclairé et recommencez. » | Tentative décomptée |
| **Visage non concordant** | « Nous n'avons pas pu confirmer que ce document est le vôtre. Un conseiller va regarder votre dossier — réponse sous 24 h. » | **Bascule en revue humaine, pas en refus** |
| Soupçon de falsification | Même message que ci-dessus, mot pour mot | Revue humaine, avec signalement interne |
| Prestataire injoignable | « Vérification indisponible pour le moment. Réessayez dans quelques minutes. » | Aucune tentative décomptée. **Ne jamais accepter par défaut** |

Deux choix qui méritent d'être défendus :

- **Un échec de concordance ne refuse pas, il met en revue.** Les vrais clients
  échouent aussi : jumeaux, photo de passeport de ses dix-huit ans, chirurgie,
  voile, mauvaise lumière. Un refus sec ferait perdre des clients honnêtes, et le
  RGPD interdit de toute façon le refus automatique sans recours (§ 5.6).
- **La falsification et la non-concordance disent la même phrase.** Un message
  différencié transforme votre parcours en banc d'essai gratuit pour celui qui
  fabrique de faux documents.

### 4.3 Réemploi

Une vérification réussie vaut **12 mois** (à trancher, § 9). Au-delà, ou si le
document expire entre-temps, on recommence. Un client qui loue trois fois dans
l'année ne passe le parcours qu'une fois — et vous ne payez qu'une fois.

---

## 5. Seuils, décisions et conformité

### 5.1 Le seuil de similarité : raisonner en taux, pas en score

Un score brut (« 0,82 ») ne veut rien dire d'un fournisseur à l'autre. Ce qui se
fixe, c'est un **point de fonctionnement**, exprimé en taux de fausse acceptation
(FMR) :

| Situation | FMR visé | Lecture |
|---|---|---|
| Location de véhicule | **1 pour 10 000** | Une usurpation acceptée toutes les 10 000 tentatives |
| Séjour de grande valeur | 1 pour 1 000 | Plus permissif : le risque est moindre |

À FMR = 10⁻⁴, les moteurs sérieux affichent un taux de faux rejet de l'ordre de
1 à 3 % sur des captures correctes. **Sur 300 vérifications par mois, cela fait
3 à 9 clients honnêtes envoyés en revue humaine.** C'est le volume de travail
qu'il faut accepter d'absorber — et c'est aussi pourquoi la revue humaine
existante est la pièce maîtresse, pas une roue de secours.

Trois zones plutôt que deux :

```
accepté          ────────────────  au-dessus du seuil haut   → passage automatique
zone grise       ────────────────  entre les deux            → revue humaine
rejeté           ────────────────  sous le seuil bas         → revue humaine + signalement
```

### 5.2 Tentatives et blocage

- **3 tentatives** par période de 24 heures, comptées côté serveur (les échecs de
  qualité d'image ne comptent pas).
- Au-delà : bascule en revue humaine, **jamais un bannissement automatique**.
- Les limites existantes de l'API (`api/lib/http.js`) s'appliquent au nouvel
  endpoint, avec un plafond plus strict : 10 créations de session par heure et par
  compte, 30 par adresse IP.
- Un même document présenté sur **deux comptes différents** déclenche une alerte
  interne. Cas légitimes possibles (famille, erreur de saisie) : c'est une alerte,
  pas un blocage.

### 5.3 Données biométriques et RGPD

Les gabarits faciaux utilisés pour identifier une personne sont une **catégorie
particulière de données** (article 9.1). Le traitement est **interdit par défaut**,
sauf exception.

| Question | Réponse pour Douira |
|---|---|
| **Base légale** | **Consentement explicite** (art. 9.2.a). Les autres exceptions ne s'appliquent pas : il n'y a pas d'obligation légale de biométrie (§ H6), et l'« intérêt légitime » n'est pas une exception de l'article 9 |
| **Conséquence du refus** | Le consentement doit être **libre** : un client qui refuse doit pouvoir faire **vérifier son dossier par un humain**. Sinon ce n'est pas un consentement, et toute la base légale s'écroule |
| **Minimisation** | Images et gabarits **ne sont pas conservés par Douira**. On garde le verdict, le motif et l'horodatage. Le prestataire conserve les captures le temps contractuel, et pas plus |
| **Conservation** | Verdict : 12 mois après la dernière réservation (durée du réemploi + marge). Images chez le prestataire : 30 jours maximum, à inscrire au contrat. Les 90 jours existants de `client_documents` restent pour l'obligation marocaine |
| **Chiffrement** | Déjà en place : `DATA_KEY` sur les numéros et images, TLS imposé vers la base |
| **Sous-traitance** | Contrat article 28 avec le prestataire. S'il traite hors UE : clauses contractuelles types + analyse de transfert |
| **AIPD** | **Obligatoire** (art. 35) : données sensibles, nouvelle technologie, évaluation systématique. À faire **avant** la mise en production, pas après |
| **Droits** | Accès, effacement, et surtout **intervention humaine** (§ 5.6). À câbler dans l'appli, pas seulement dans les CGU |

### 5.4 Maroc et Sénégal — à ne pas oublier

L'appli opère à Marrakech et à Dakar. Le RGPD n'est pas seul.

- **Maroc, loi 09-08** : la CNDP soumet le traitement de données biométriques à
  **autorisation préalable** — une formalité plus lourde qu'une déclaration, et
  dont le délai d'instruction doit entrer dans votre calendrier.
- **Sénégal, loi 2008-12** : régime comparable auprès de la CDP.
- Ces démarches sont **séquentielles et incompressibles**. Elles doivent démarrer
  en phase 1, pendant que le développement avance.

### 5.5 L'AIPD, concrètement

Ce n'est pas un formulaire : c'est le document qui décrit le traitement, les
risques pour les personnes et ce que vous faites contre. Les points qui vous
seront opposés : la **proportionnalité** (pourquoi la biométrie plutôt qu'une
vérification humaine ?), le **ciblage** (§ 2.1 est votre meilleure réponse), et
les **biais démographiques** du moteur choisi — demandez au prestataire ses
résultats par groupe démographique, notamment les écarts sur les peaux foncées et
sur les femmes, documentés dans les évaluations du NIST.

### 5.6 Décision automatisée : le droit au recours humain

Un refus automatique qui empêche de réserver est une **décision automatisée
produisant un effet significatif** (art. 22). Vous devez :

1. **Informer** que la décision est automatisée ;
2. offrir une **intervention humaine** — c'est `documents-review.tsx`, déjà
   construit, à étendre au verdict biométrique ;
3. permettre de **contester** la décision.

C'est la raison la plus forte de **ne jamais refuser durement** (§ 4.2) : le
recours n'est pas une faveur commerciale, c'est une obligation.

---

## 6. Sécurité

| Attaque | Ce que fait l'attaquant | Mitigation |
|---|---|---|
| **Photo imprimée** | Présente une photo papier du titulaire | PAD niveau 1 certifié iBeta (analyse de texture, reflets, profondeur) |
| **Écran rejoué** | Présente une vidéo sur un téléphone | PAD niveau 1 : moiré, fréquence de rafraîchissement, reflets d'écran |
| **Masque 3D** | Masque en silicone ou résine | PAD **niveau 2** — à exiger explicitement du prestataire, ce n'est pas toujours inclus |
| **Deepfake en temps réel** | Substitue un visage pendant le flux | Défis **aléatoires pilotés par le serveur** + détection d'artefacts côté prestataire. C'est le front qui bouge le plus vite : c'est pourquoi le modèle ne doit pas être figé dans l'app (§ 2.2) |
| **Injection de flux** | Caméra virtuelle, appareil débridé, appli réinstrumentée. **L'attaque qui monte** | SDK avec attestation d'intégrité (App Attest / Play Integrity), détection d'émulateur, et **signature des captures par le SDK** |
| **Document volé** | Vrai passeport, mauvais porteur | C'est exactement ce que la comparaison faciale attrape. Renforcé par le NFC (§ 3.4) |
| **Faux document** | Document fabriqué, portrait du fraudeur | Contrôles d'authenticité du prestataire ; **NFC = la réponse définitive** sur les passeports |
| **Rejeu de session** | Réutilise un jeton réussi | Jeton à usage unique, lié au compte, TTL de 15 minutes, verdict reçu **uniquement par webhook signé** |
| **Verdict falsifié côté app** | Réécrit la réponse réseau | L'appli n'envoie jamais de verdict (§ 2.3). Point unique, et c'est le plus important de ce tableau |
| **Fuite de données** | Accède aux images | Douira ne les stocke pas. L'existant reste chiffré, l'accès reste tracé |
| **Abus interne** | Un collaborateur consulte des pièces sans motif | `fileFor()` limite déjà aux pièces en attente et journalise. À étendre : alerte au-delà de N consultations par jour |
| **Capture d'écran** | Enregistre l'écran de vérification | `expo-screen-capture`, déjà utilisé par `private-screen.tsx`, à appliquer au parcours |

**Deux règles à écrire en dur :**

1. **Un prestataire injoignable ne vaut jamais acceptation.** Le défaut est le
   refus temporaire, avec un message honnête.
2. **Le webhook est authentifié par signature**, pas par une URL secrète. Une URL
   fuit dans les journaux ; une signature, non.

---

## 7. Tests et qualité

### 7.1 Jeux de données — ce qu'on s'interdit

**Jamais de documents de vrais clients dans un jeu de test.** Ni en recette, ni
en démonstration, ni « juste une fois pour voir ». À utiliser :

- les **spécimens** fournis par le prestataire en bac à sable ;
- les documents de l'équipe, avec **consentement écrit** et suppression après
  recette ;
- les spécimens publics des États (passeport spécimen français, par exemple).

### 7.2 Métriques à suivre

| Métrique | Cible de départ | Pourquoi |
|---|---|---|
| **FRR** — vrais clients rejetés | < 5 % | Au-delà, le parcours coûte plus de clients qu'il n'évite de fraudes |
| **FAR** — imposteurs acceptés | < 0,01 % | Le point de fonctionnement du § 5.1 |
| **Taux d'abandon** | < 20 % | Mesure la gêne réelle, et c'est le chiffre que personne ne regarde |
| **Taux de revue humaine** | < 10 % | Au-delà, votre équipe devient le goulot |
| **Temps de bout en bout** | < 90 s au 90ᵉ centile | Le ressenti, pas la moyenne |
| **Écart entre groupes démographiques** | À mesurer, pas à supposer | Un moteur qui rejette deux fois plus certains profils est un problème légal autant que moral |

### 7.3 Protocole de recette, avant production

1. **50 parcours nominaux** sur appareils réels, iOS et Android, lumière variée —
   dont des documents marocains et sénégalais, pas seulement européens.
2. **20 tentatives d'attaque** : photo imprimée, photo sur écran, vidéo rejouée,
   et si possible un masque. **Objectif : zéro acceptation.**
3. **10 documents étrangers** hors des deux marchés.
4. **Parcours de panne** : prestataire coupé, réseau coupé en plein envoi,
   webhook perdu puis rejoué.
5. **Parcours de recours** : un rejet qui part en revue humaine, est examiné et
   accepté — bout en bout, avec le client notifié.

Rien ne part en production tant que le point 2 n'est pas à zéro.

> **À dire franchement** : ces tests demandent des appareils réels, des documents
> physiques et un bac à sable fournisseur. Aucun ne peut être exécuté depuis cet
> environnement de développement, et je ne pourrai pas vous dire qu'ils sont
> passés — c'est vous qui les ferez passer.

---

## 8. Feuille de route

| Phase | Contenu | Effort (1 dév.) | Risque principal |
|---|---|---|---|
| **0 — Décider** | Choisir un prestataire (2 ou 3 bacs à sable testés sur **vos** documents), lancer l'AIPD et le dossier CNDP | 1 à 2 semaines, **plus les délais administratifs** | Les délais réglementaires dépassent le développement. **À démarrer en premier** |
| **1 — Socle** | Development build EAS, table `kyc_checks`, endpoint de session, webhook signé, écran d'état | 1 à 2 semaines | La bascule hors d'Expo Go perturbe la boucle de travail quotidienne |
| **2 — MVP** | Parcours complet sur la **seule location de véhicule** : document + vivacité + comparaison, échecs, revue humaine étendue | 2 à 3 semaines | Les cas d'échec prennent plus de temps que le cas nominal. Toujours |
| **3 — Durcir** | Lecture NFC des passeports, attestation d'intégrité, tableau de bord des métriques, alertes de fraude | 2 à 3 semaines | La lecture BAC/PACE est pénible ; prévoir large |
| **4 — Étendre** | Élargir aux séjours de grande valeur si les chiffres le justifient | 1 semaine | Élargir sans mesurer, c'est payer pour rien |

**Total jusqu'au MVP utilisable : 4 à 7 semaines de développement**, sans compter
les délais d'autorisation, qui courent en parallèle et peuvent être plus longs.

---

## 9. Ce que vous devez trancher — personne ne peut le faire à votre place

1. **Le périmètre.** Véhicules seulement, ou aussi les séjours au-dessus d'un
   seuil ? Si oui, quel montant ? *(§ 2.1 — la décision qui pèse le plus sur le
   coût et sur l'exposition réglementaire.)*
2. **Le prestataire.** À choisir après avoir testé la couverture **réelle** de la
   CIN marocaine et de la CNI sénégalaise sur vos propres documents.
3. **Le budget mensuel acceptable**, minimums contractuels compris.
4. **Le point de fonctionnement.** 1/10 000 pour les véhicules, ou plus strict ?
   Chaque cran gagné sur la fraude se paie en clients honnêtes envoyés en revue.
5. **Qui tient la revue humaine**, et sous quel délai annoncé. Le délai sera écrit
   dans un message au client : il doit être tenable.
6. **La durée de validité d'une vérification.** 12 mois est une proposition.
7. **Qui pilote l'AIPD et le dossier CNDP.** Si la réponse est « personne pour
   l'instant », c'est le premier point à régler, avant toute ligne de code.
8. **Le parcours de secours pour qui refuse la biométrie.** Vérification
   entièrement humaine, ou renoncement à la location ? *(La première est, à mon
   sens, la seule compatible avec un consentement libre.)*

---

## 10. Ce que je ne recommande pas, et pourquoi

- **Faire la comparaison sur l'appareil.** Le verdict appartiendrait à celui qu'on
  vérifie (§ 2.2).
- **Un moteur facial maison.** Vous perdriez sur la vivacité, c'est-à-dire sur
  tout (§ 3.1, option C).
- **Vérifier tout le monde dès l'inscription.** Cher, dissuasif, et le pire des
  cas du point de vue réglementaire (§ 2.1).
- **Stocker les images ou les gabarits chez Douira.** Toute la charge, aucun des
  usages (§ 2.4).
- **Un refus automatique sans recours.** Interdit, et commercialement perdant
  (§ 5.6).

---

### Sources des ordres de grandeur tarifaires

Chiffres indicatifs, issus de comparatifs tiers de 2026 — à confirmer par devis :
[comparatif KYC Sumsub / Onfido / Jumio / Veriff](https://tech-insider.org/igt-sumsub-vs-onfido-vs-jumio-vs-veriff-for-igaming-kyc-202-en-d169/),
[coûts KYC et modèles tarifaires](https://didit.me/blog/kyc-costs-explained-pricing-models-hidden-fees-revealed/),
[tarification Amazon Rekognition](https://aws.amazon.com/es/rekognition/pricing/),
[baisse de tarifs des API Image Rekognition](https://aws.amazon.com/about-aws/whats-new/2021/11/amazon-rekognition-pricing-apis/).
