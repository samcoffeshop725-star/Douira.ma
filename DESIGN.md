---
version: alpha
name: Douira-design-system
description: Douira est une plateforme de séjours, d'expériences et de services à Marrakech et Dakar. Son système visuel est « Marrakech ville rouge » — un ivoire clair comme canevas, des cartes blanches qui s'en détachent, des filets presque invisibles, et UNE seule voix forte, la terre cuite (#A8432A), réservée aux actions. Le luxe tient au blanc qu'on laisse autour des choses, pas à l'intensité des couleurs. Le motif zellige (étoile à huit branches dessinée au trait) court en filigrane très pâle sur toute la page et devient le sujet quand il n'y a pas de photo. Type en Outfit à graisses modestes (300–600, jamais 700), une italique Cormorant Garamond pour l'accent éditorial. Tout est en pilule ou en coins amples (8 → 24 px) ; aucun angle dur. Mêmes jetons sur le site (douira.ma) et l'application (Expo), en clair et en sombre.

colors:
  accent: "#A8432A"
  accent-ink: "#FFFFFF"
  accent-soft: "#F7E5DC"
  accent-dark-mode: "#EE9C74"
  gold: "#8F5E0F"
  gold-soft: "#F6E7C8"
  safran: "#E0A526"
  ocre: "#A8652A"
  ocre-soft: "#F3E4D0"
  majorelle: "#3B46B8"
  majorelle-soft: "#E4E6F8"
  diamond: "#2E48AE"
  diamond-soft: "#DEE4F9"
  slate: "#7A3320"
  night: "#5A2718"
  ink: "#241A16"
  muted: "#7A6A61"
  canvas: "#FBF7F1"
  canvas-site: "#FBF6EC"
  surface: "#FFFFFF"
  surface-2: "#F7F1E9"
  background-element: "#F2EBE1"
  background-selected: "#E9DFD2"
  line: "#E8DFD3"
  overlay: "rgba(255,252,248,0.94)"
  ok: "#2E7346"
  ok-soft: "#DDEEDF"
  warn: "#925A00"
  warn-soft: "#F7E8CB"
  bad: "#A83232"
  bad-soft: "#F6DCD8"
  info: "#2C5597"
  info-soft: "#DDE6F4"
  map-land: "#F3E9DA"
  map-land-line: "#DCC6AA"
  map-sea: "#D6E4EE"
  dark-canvas: "#1A1412"
  dark-surface: "#241C19"
  dark-surface-2: "#2B1E1C"
  dark-line: "#3A2E29"
  dark-ink: "#F2E7D8"
  dark-muted: "#BBA99E"
  dark-accent-ink: "#2A0D04"
  dark-accent-soft: "#46271F"
  dark-gold: "#E5B65E"
  dark-overlay: "rgba(26,20,18,0.88)"

typography:
  display:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 34px
    fontWeight: 600
    lineHeight: 42px
    letterSpacing: 0.2px
  title:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 600
    lineHeight: 31px
    letterSpacing: 0
  heading:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 24px
    letterSpacing: 0
  body:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 23px
    letterSpacing: 0
  small:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 19px
    letterSpacing: 0
  label:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 11.5px
    fontWeight: 500
    lineHeight: 15px
    letterSpacing: 1.2px
    textTransform: uppercase
  editorial-accent:
    fontFamily: "'Cormorant Garamond', Georgia, serif"
    fontStyle: italic
    fontWeight: 500
  button:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.3
  price-marker:
    fontFamily: "'Outfit', system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 600

rounded:
  sm: 8px
  md: 12px
  site: 14px
  lg: 18px
  xl: 24px
  full: 999px

spacing:
  half: 2px
  one: 4px
  two: 8px
  three: 16px
  four: 24px
  five: 32px
  six: 64px
  reading-width: 800px
---

## Overview

Douira vend trois choses — des **logements**, des **expériences** et des **services** — à Marrakech et à Dakar, et son interface doit faire sentir le lieu sans jamais le caricaturer. La direction s'appelle « Marrakech ville rouge » : le sable rosé du pisé, le rouge des remparts, le safran du couchant. Mais elle est tenue par une règle plus forte que la palette : **le luxe tient au blanc qu'on laisse autour des choses, pas à l'intensité des couleurs.**

Le canevas est un **ivoire clair** (`{colors.canvas}` — #FBF7F1 dans l'application, `{colors.canvas-site}` — #FBF6EC sur le site), pas un sable saturé. Les cartes sont **blanches** (`{colors.surface}`) et s'en détachent d'un cheveu — filet `{colors.line}` presque invisible, ombre douce — jamais par une bordure marquée. L'encre est un brun très sombre (`{colors.ink}` — #241A16), jamais du noir.

Une seule voix forte : la **terre cuite** (`{colors.accent}` — #A8432A). Elle ne sert **qu'aux actions** — bouton principal, sélection, pastille active, prix choisi sur la carte. Le reste de la page est ivoire, blanc et brun. Le **safran** (`{colors.safran}`) n'est pas une couleur d'interface : c'est celle des ornements zellige sur fond sombre. Le **bleu Majorelle** (`{colors.majorelle}`) ne porte que le niveau « Diamond » de la carte de membre et quelques accents zellige du site.

Le **zellige** est la signature. C'est une étoile à huit branches dessinée au trait — deux carrés superposés, l'un tourné d'un huitième de tour, un cercle au centre. Il court sur **toute la page** en treillis si pâle qu'on ne le remarque pas, mais qu'on regretterait s'il disparaissait. Et quand un service n'a pas de photo, le même motif, plus affirmé, devient le visuel : un panneau dessiné plutôt qu'un cadre gris qui ressemble à une image non chargée.

**Caractéristiques clés :**
- Un accent, la terre cuite, réservé aux actions. Sur une page type, 95 % de la surface est ivoire, blanc et brun.
- Outfit à graisses modestes : 400 pour le texte, 500 pour les libellés, 600 pour les titres. **Jamais 700.** La hiérarchie vient de la taille et de la couleur, pas du poids.
- Une italique Cormorant Garamond pour une touche éditoriale, rare.
- Tout est arrondi : pilules pour la recherche, les pastilles et les boutons ; 18 px pour les cartes ; 24 px pour les grandes images et les feuilles. Aucun angle dur.
- Trois niveaux d'ombre, tous doux. Une ombre marquée fait bon marché.
- Grille de 4 px : 2 · 4 · 8 · 16 · 24 · 32 · 64. Largeur de lecture bornée à 800 px.
- Filigrane zellige sur toute la page (opacité 0,02–0,06), ornement d'étoile devant chaque titre de section du site, frises entre les sections, images de section en arche.
- Les photographies portent le poids visuel. Sans photo, on **dessine** — on n'emprunte pas une image qui ne montre pas la chose.

## Colors

### Marque et accent
- **Terre cuite** (`{colors.accent}` — #A8432A) : la seule couleur d'action. Bouton principal, pastille sélectionnée, cœur enregistré, cercle de zone sur la carte, icône de catégorie. Son encre est blanche (`{colors.accent-ink}`). En mode sombre elle s'éclaircit en `{colors.accent-dark-mode}` (#EE9C74) avec une encre brune (`{colors.dark-accent-ink}`).
- **Terre cuite douce** (`{colors.accent-soft}` — #F7E5DC) : fond des pastilles d'information, du disque d'icône dans les états vides, du panneau zellige dessiné. Jamais pour du texte.
- **Or** (`{colors.gold}` — #8F5E0F, fond `{colors.gold-soft}`) : le niveau « Gold » de la carte de membre et les badges d'or. Pas un accent général.
- **Safran** (`{colors.safran}` — #E0A526) : ornements zellige sur fonds sombres (pied de page, bandeau de confiance). N'apparaît jamais en aplat.
- **Ocre** (`{colors.ocre}` — #A8652A) : second brun chaud du site, pour les fonds de section « sable 2 ».
- **Majorelle** (`{colors.majorelle}` — #3B46B8 ; application `{colors.diamond}` — #2E48AE) : le niveau « Diamond », et lui seul.
- **Ardoise** (`{colors.slate}` — #7A3320) et **nuit** (`{colors.night}` — #5A2718) : terre cuite profonde du pied de page et des bandeaux sombres du site.

### Surfaces
- **Canevas** (`{colors.canvas}` — #FBF7F1) : le fond de toute page. Ivoire, pas crème saturée. Le site utilise `{colors.canvas-site}` (#FBF6EC), un cheveu plus chaud.
- **Surface** (`{colors.surface}` — #FFFFFF) : cartes, barre de recherche, pastilles, feuille de résultats. Le blanc est ce qui fait respirer la page.
- **Surface 2** (`{colors.surface-2}` — #F7F1E9) et **élément** (`{colors.background-element}` — #F2EBE1) : remplissages légers — cadre d'image avant chargement, fond de champ.
- **Sélection** (`{colors.background-selected}` — #E9DFD2) : poignée de la feuille, ligne active d'une liste.
- **Voile** (`{colors.overlay}` — rgba(255,252,248,0.94)) : pastille posée SUR une photo ou une carte — retour, partage, cœur, légende de zone. Presque opaque pour rester lisible sur une image claire comme sombre ; en sombre, `{colors.dark-overlay}`.
- **Carte géographique** : terres `{colors.map-land}`, routes `{colors.map-land-line}`, eau `{colors.map-sea}` (site).

### Filets et bordures
- **Filet** (`{colors.line}` — #E8DFD3) : LA bordure, 1 px, partout — cartes, barre de recherche, pastilles inactives, haut de la feuille (en hairline). Presque invisible : il sépare, il ne souligne pas.
- Il n'existe pas de bordure forte. Une bordure de 2 px n'apparaît que sur la pastille d'un filtre actif, en encre.

### Texte
- **Encre** (`{colors.ink}` — #241A16) : titres, texte courant, libellés de navigation. Jamais du noir pur.
- **Atténué** (`{colors.muted}` — #7A6A61) : sous-titres, notes, dates, prix par nuit sous un titre, libellés de section en capitales.
- Il n'y a que ces deux rôles de texte, plus l'accent pour un sur-titre de catégorie. Pas de troisième gris.

### Sémantique
Chaque état a une encre et un fond doux, et ne sert qu'à dire un état — jamais à décorer :
- **Ok** `{colors.ok}` / `{colors.ok-soft}` — confirmé, réglé, publié.
- **Attention** `{colors.warn}` / `{colors.warn-soft}` — en cours, à payer, paiement en attente.
- **Erreur** `{colors.bad}` / `{colors.bad-soft}` — échec, refus.
- **Information** `{colors.info}` / `{colors.info-soft}` — neutre informatif.

### Mode sombre
Les mêmes rôles, renversés sans changer d'idée : canevas `{colors.dark-canvas}` (#1A1412), surfaces `{colors.dark-surface}` / `{colors.dark-surface-2}`, filet `{colors.dark-line}`, encre `{colors.dark-ink}` (#F2E7D8), atténué `{colors.dark-muted}`. L'accent s'éclaircit (#EE9C74), l'or aussi (`{colors.dark-gold}`). Le filigrane zellige passe en beige pâle (#E7C9A6 à 0,05). Les deux modes existent sur le site et dans l'application.

## Typography

### Familles
**Outfit** pour tout — titres, texte, navigation, libellés, boutons — en quatre graisses seulement : 300, 400, 500, 600. Il n'y a **pas de 700** dans le système ; un titre en 600 à 24 px suffit, parce que les photographies portent le poids.

**Cormorant Garamond** en italique (400 et 500) pour l'accent éditorial : un mot dans un titre, une citation. Rare, et toujours en italique.

**IBM Plex Mono** (400, 500) est chargée sur le site pour ses éléments techniques (`--f-mono`) ; elle n'existe pas dans l'application.

Sur mobile, les polices sont embarquées (`@expo-google-fonts/outfit`), pas chargées par le réseau.

### Hiérarchie
Six niveaux, pas davantage : au-delà, deux titres se ressemblent et la hiérarchie se perd. Les interlignes sont généreux — c'est ce qui distingue une page éditoriale d'un formulaire.

| Jeton | Taille | Graisse | Interligne | Interlettrage | Usage |
|---|---|---|---|---|---|
| `{typography.display}` | 34px | 600 | 42px | 0.2px | Titre d'onglet (« Réservations »), grand chiffre |
| `{typography.title}` | 24px | 600 | 31px | 0 | Titre d'une fiche (nom du logement, du service) |
| `{typography.heading}` | 18px | 600 | 24px | 0 | Titre de section (« À payer », « Séjours à venir ») |
| `{typography.body}` | 15px | 400 | 23px | 0 | Texte courant, descriptions |
| `{typography.small}` | 13px | 400 | 19px | 0 | Notes, dates, sous-titres de carte |
| `{typography.label}` | 11.5px | 500 | 15px | 1.2px, capitales | Sur-titre de catégorie (« CULTURE », « SAUNA & HAMMAM ») |

Compléments d'interface : libellés de bouton et de pastille en 14 px / 500 ; prix sur une pastille de carte en 13 px / 600 ; titre d'une carte de liste en 15–16 px / 600.

### Principes
- La hiérarchie vient de la taille et de la couleur (encre / atténué / accent), jamais du poids.
- Les capitales n'existent qu'au niveau `{typography.label}`, aéré par son interlettrage. Tout le reste est en casse de phrase.
- Un petit texte ne prend jamais d'interlettrage négatif.
- Les chiffres (prix, notes) sont tabulaires et suivent un seul format : « 1100 MAD », « 350 MAD / nuit », « Sur devis » quand il n'y a pas de tarif.

## Layout

### Espacement
- **Unité :** 4 px, avec un demi-pas de 2 px pour les réglages fins.
- **Jetons :** `{spacing.half}` 2 · `{spacing.one}` 4 · `{spacing.two}` 8 · `{spacing.three}` 16 · `{spacing.four}` 24 · `{spacing.five}` 32 · `{spacing.six}` 64.
- **Marges de page :** `{spacing.three}` (16 px) sur mobile.
- **Padding de carte :** `{spacing.three}` (16 px) ; carte dense `{spacing.two}` (8 px).
- **Entre deux cartes :** `{spacing.two}` à `{spacing.four}` selon la densité ; entre deux sections `{spacing.four}` (24 px) ; bas de liste `{spacing.six}` (64 px) pour dégager la barre d'onglets.
- Toute valeur hors grille (13 px, 11 px) est une erreur.

### Grille et conteneur
- **Largeur de lecture :** `{spacing.reading-width}` (800 px). Sur tablette, les listes se rangent en colonnes au lieu de grossir les cartes.
- **Mobile d'abord.** L'application est native ; le site est responsive.
- **Écran « carte + feuille »** (logements, expériences, services) : en-tête (retour · pastille-résumé · action), barre de raccourcis, carte sur tout le reste, feuille de résultats posée dessus avec deux positions — **52 %** de l'écran (carte dégagée) et **12 %** (liste en grand). La fiche d'un point choisi se pose par-dessus la feuille, en bas.

### Philosophie du blanc
Le blanc n'est pas du vide, c'est le luxe. Une carte blanche sur ivoire, un filet presque invisible, de l'air autour d'un titre : c'est ce qui fait qu'une page Douira ne ressemble pas à un formulaire administratif. On enlève avant d'ajouter.

## Elevation

Trois niveaux, tous **doux**. Une ombre ne sert qu'à décoller une carte de son fond d'un cheveu, jamais à attirer l'œil.

- **Plat :** la page, les sections, la plupart des listes.
- **Carte** (`Elevation.card`) : `rgba(42,29,20,0.05)` · décalage 0 / 3 · flou 10. Les cartes au repos.
- **Relevé** (`Elevation.raised`) : `rgba(42,29,20,0.09)` · décalage 0 / 6 · flou 18. La feuille de résultats, l'aperçu posé sur la carte, la bande de cartes.
- Site : `0 1px 2px rgba(43,30,28,.06), 0 8px 28px rgba(43,30,28,.1)` (une seule définition, `--shadow`).
- L'ombre est toujours teintée du brun de l'encre (#2A1D14), jamais noire.
- En mode sombre, la profondeur vient des paliers de surface et des filets, pas des ombres.

## Components

### Recherche
**`search-pill`** — La pastille-résumé en tête des écrans de résultats : surface blanche, filet 1 px, pilule, hauteur 52 px, icône loupe puis deux lignes (ce qu'on cherche en 14 px / 600, où et quand en 12 px atténué). Ce n'est **pas un champ** : la toucher rouvre le panneau de recherche, pour que le clavier ne monte pas sur les résultats.

**`search-bar`** — Le champ de saisie, là où l'on tape : même forme en pilule, hauteur 48 px, croix d'effacement quand il y a du texte.

**`chip`** — Pastille de raccourci ou de catégorie : pilule, padding 9 × 16 px, surface blanche et filet au repos ; **encre en fond et ivoire en texte** quand elle est active. Une icône de catégorie en accent, 16 px, à gauche du libellé. Un filtre actif porte un filet de 2 px en encre et un badge compteur en accent.

### Boutons
**`button-primary`** — Fond terre cuite, texte blanc 14 px / 500, pilule. L'unique bouton coloré d'un écran.
**`button-secondary`** — Surface blanche, filet, texte encre. Le plus courant.
**`button-ghost`** — Texte seul, sans surface. Pour « Annuler », « Retirer ».
Hauteur 48 px. Un bouton qui ne peut rien faire n'est pas grisé : il n'est pas affiché.

### Cartes
**`card`** — Surface blanche, filet 1 px, rayon `{rounded.lg}` (18 px), ombre `card`. Padding 16 px (dense : 8 px).

**`listing-card`** — Photo d'abord : carrousel au ratio 1,18 clipé à `{rounded.xl}`, cœur dans une pastille-voile en haut à droite, badge de remise (« −10 % · Séjours en famille ») en bas à gauche sur fond terre cuite, points de pagination blancs. Dessous : quartier et ville en titre, une ligne de description, capacité, puis le prix « 1100 MAD / nuit » avec l'unité en atténué.

**`service-card`** — Même carte, mais le bandeau du haut est la photo **ou**, sans photo, le **panneau zellige dessiné** (`service-visual`) : fond `{colors.accent-soft}`, treillis d'étoiles à huit branches en trait terre cuite de 1 px à 0,16 d'opacité sur une tuile de 40 px, icône de catégorie au centre en 56 px. Pas de légende : le nom de la catégorie est écrit juste dessous.

**`map-preview`** — La fiche posée sur la carte quand on touche un point : surface, filet, ombre relevée, photo carrée de 92 px à gauche, sur-titre de catégorie, titre sur deux lignes, sous-titre, valeur ; croix de fermeture.

### Carte géographique
**`price-marker`** — Pastille posée sur la carte : surface blanche, filet, pilule, padding 7 × 12 px, prix ou nom en 13 px / 600. **Active : encre en fond, ivoire en texte.** Les groupes s'écrivent « 6 logements », « 3 expériences ».
**`map-zone`** — Pour les services qui viennent chez le client : un cercle d'accent à 8 % de remplissage et 40 % de contour, 1,5 px, sur la ville — jamais un faux point.
**`results-sheet`** — La feuille de résultats : fond canevas, coins supérieurs `{rounded.xl}`, hairline, ombre relevée, poignée de 48 × 5 px en `{colors.background-selected}`, compte en 16 px / 600 centré, chevron à droite.

### États et badges
**`badge`** — Pilule sur fond doux avec l'encre de son état : `ok` (« Confirmée », « Réglée », « Publié »), `warn` (« À payer », « En cours »), `bad`, `info`, `gold`, `diamond`, `neutral`.
**`empty-state`** — Disque de 72 px en `{colors.accent-soft}` avec l'icône en accent, titre en 18 px / 600, message atténué, puis un ou deux boutons. Il dit **lequel** des cas on est : rien dans le catalogue, filtre trop étroit, ou chargement en panne — jamais le même texte pour les trois.
**`loader`** — Un indicateur discret, jamais un écran entier qui tourne.

### Carte de membre
**`member-card`** — Format carte bancaire, largeur donnée en nombre (jamais en flex), hauteur par ratio. Quatre niveaux — classique, bronze, **gold** (dominante `{colors.gold}`), black — décidés par l'équipe, sans pourcentage affiché. Recto : « DOUIRA », le niveau, le numéro, « TITULAIRE » et le nom. Verso : le code QR. **Le code ne s'affiche que sur un écran protégé** des captures ; posée ailleurs, la carte ne se retourne pas et emmène vers cet écran.

### Livrées des cartes et des badges
Les valeurs vivent dans `theme.ts` (`CardTiers`, `BadgeTiers`). Chaque livrée a un fond, un second fond pour le relief, une encre, une encre discrète et un trait.

| Livrée | Fond | Relief | Encre | Usage |
|---|---|---|---|---|
| Classique | #F3E6D6 | #E4D2BC | #2A1D14 | Carte de membre par défaut |
| Bronze | #8C5A33 | #6E4223 | #FFF4E8 | Carte de membre |
| Gold | #C9A227 | #9C7B13 | #231A05 | Carte de membre |
| Black | #15100D | #2A211B | #F6EFE6 | Carte de membre la plus haute **et** badge de l'administration |
| Équipe | #2F3E36 | #44584C | #F2F6F3 | Badge des collaborateurs |

Les encres discrètes sont l'encre à 60–72 % d'opacité, les traits l'encre à 14–22 %.

### Étoiles et notes
**`stars`** — Cinq étoiles avec remplissage par demi-pas (4,5 = quatre et demie, pas cinq). Les étoiles vides sont en atténué à 50 % d'opacité, pour rester visibles sur ivoire. Une note sans avis ne s'affiche pas.

### Ornements (site)
- **Filigrane de page** : tuile de 72 px, trait terre cuite à 0,06 (clair) / beige à 0,05 (sombre), en `body{background-image}`.
- **Étoile de titre** : étoile pleine à huit branches en safran devant chaque `h2` de section.
- **Frise** : bande horizontale de losanges terre cuite entre les sections.
- **Arche** : images de section à coins supérieurs très arrondis.
- **Filigrane doré** : trait safran sur les fonds sombres (pied de page, bandeau de confiance), opacité ~0,10 ; sur le héros, trait pâle (#F0D28A) à 0,16.

## Do's and Don'ts

**À faire**
- Une seule couleur forte par écran, et c'est la terre cuite, et elle fait quelque chose.
- Laisser du blanc. Enlever avant d'ajouter.
- Tout sur la grille de 4 px ; mêmes hauteurs pour les mêmes choses.
- Dessiner le zellige quand il manque une photo ; dire « Sur devis » quand il manque un prix.
- Dire l'état vrai : « Rien à afficher », « Services non chargés », « Aucun service ne correspond » sont trois phrases différentes parce que ce sont trois situations différentes.
- Écrire en français, en casse de phrase, sans point d'exclamation, sans « ! » ni « ✨ ».
- Garder l'opacité des filigranes entre 0,02 (application) et 0,16 (héros du site).

**À ne pas faire**
- **Aucun émoji** dans l'interface, nulle part — pas même un drapeau : un pays se montre par son code ISO en étiquette (`CountryTag`, « MA »).
- **N'inventer aucune donnée** : prix, notes, avis, photos, numéros de téléphone, coordonnées GPS. Un champ vide se dit vide.
- Pas de 700 en graisse, pas de dégradé de teinte, pas de texte en dégradé, pas de lueur colorée, pas d'ombre noire, pas d'angle dur.
- Pas de violet, pas de bleu électrique comme accent — le Majorelle est réservé au niveau Diamond.
- Pas d'image empruntée pour « habiller » : une photo de la Koutoubia derrière « Ménage en cours de séjour » n'est pas une photo du ménage.
- Pas de `background-blend-mode: soft-light` sur le filigrane doré : il devient criard.
- Pas de bouton qui ne fait rien, pas de carte qui ne se touche pas, pas de contrôle qui disparaît en laissant l'utilisateur enfermé.
- Ne pas toucher à l'affichage des prix ni à la conversion en euros sans décision explicite.

## Responsive Behavior

| Nom | Largeur | Changements |
|---|---|---|
| Téléphone | < 744 px | Tout en une colonne ; marges de 16 px ; barre d'onglets en bas (50 px iOS, 80 px Android) ; feuille de résultats en deux positions ; clavier jamais sur les résultats (la recherche se tape dans un panneau). |
| Tablette | 744–1100 px | Les listes de cartes se rangent en colonnes (`useLayout`), la largeur de lecture reste bornée à 800 px pour le texte. |
| Site, large | > 1100 px | Contenu centré et borné ; les sections gardent leur frise et leur étoile ; images en arche. |

### Cibles tactiles
- Boutons et pastilles : 48 px de haut.
- Pastilles sur photo (retour, partage, cœur) : 40–48 px, dans une pastille-voile.
- Poignée de feuille : toute la bande en tête se tire, pas seulement le trait de 5 px.

## Agent Prompt Guide

- « Construis cet écran dans le langage de ce DESIGN.md » suffit ; les jetons sont ceux de `src/constants/theme.ts` (application) et de `build/z_theme.css` (site).
- Avec **taste-skill** : ses règles maison interdisent ivoire-et-terracotta, les filets et les sur-titres en capitales. **Ce DESIGN.md prime** : utiliser taste-skill pour la composition, le rythme et la critique du rendu, et lui refuser tout changement de palette, de filet ou de libellé.
- Avec **unslop** : c'est l'outil de polissage qui respecte la marque — à préférer pour retoucher un écran existant.
- Avec **web-design-guidelines** : pour une revue accessibilité et UX d'un fichier, sans toucher au style.
- Avec **playwright-cli** : ouvrir le site en `--device="iPhone 15"`, capturer, et comparer à ce document — les couleurs, les rayons et la grille se vérifient à l'image.

## Known Gaps

- **Dérive site / application** sur trois jetons : canevas (#FBF6EC / #FBF7F1), filet (#E8DCC8 / #E8DFD3), encre (#2B1E1C / #241A16). Volontaire à l'origine (l'application a été éclaircie), mais à réconcilier.
- **Photos de services** : aucune n'existe encore ; le panneau zellige dessiné les remplace.
- **Mode sombre du site** : les jetons existent, le rendu complet de chaque section n'a pas été vérifié écran par écran.
- **Monospace** : IBM Plex Mono est chargée sur le site ; son usage exact section par section n'est pas documenté ici.
- **Tablette** : l'écran « carte + feuille » reste en une colonne ; une version en colonnes n'a pas été dessinée.
