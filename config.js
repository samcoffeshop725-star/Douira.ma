/* =====================================================================
   DOUIRA · configuration du site en ligne
   C'est le seul fichier à modifier avant la mise en ligne.
   Enregistrez-le en UTF-8. Les textes vont entre guillemets.
   Tant qu'un champ est vide, le site l'indique dans la console du
   navigateur (F12 → Console) : « À compléter dans config.js ».

   NB : les biens et activités ci-dessous ont été générés comme point de
   départ. Remplacez-les par vos vraies informations (prix, descriptions,
   photos, n° d'autorisation). N'indiquez JAMAIS ici l'adresse exacte ni
   le code d'accès d'un logement : ce fichier est public.
   ===================================================================== */
window.DOUIRA_CONFIG = {
  // 'demo'    : site complet (logements, comptes, espace administrateur,
  //             réservations, factures) avec des données d'exemple. Paiements
  //             et e-mails simulés ; chaque visiteur a sa propre copie des
  //             données, dans son navigateur. Pour votre ordinateur ou un essai
  //             en ligne (non indexé par les moteurs de recherche).
  // 'vitrine' : version pour le vrai public, sans comptes ni paiement en ligne.
  //             Les demandes partent sur votre WhatsApp.
  mode: 'en-ligne',

  siteName: 'Douira',
  siteUrl: 'https://douira-tsof.onrender.com',            // après l'achat du domaine, ex. 'https://www.votre-domaine.ma'
  whatsapp: '',           // À COMPLÉTER : numéro qui reçoit les demandes, ex. '+212 6 12 34 56 78'
  // E-mail de l'administrateur : reçoit les demandes envoyées par e-mail et
  // s'affiche sur le site comme adresse de contact.
  email: 'douira.services@gmail.com',
  villes: ['Marrakech'],
  markupPct: 12.5,        // majoration appliquée au prix du propriétaire (jamais affichée)

  // Fond de la carte des logements. Vide : OpenStreetMap (gratuit, sans clé).
  carte: {
    tuiles: '',
    attribution: ''
  },

  societe: {
    raisonSociale: 'Douira',   // À COMPLÉTER : raison sociale exacte, ex. 'Douira SARL'
    ice: '',                   // À COMPLÉTER
    rc: '',                    // À COMPLÉTER
    adresse: '',               // À COMPLÉTER : adresse du siège
    cndp: ''                   // À COMPLÉTER : n° de récépissé ou d'autorisation CNDP
  },

  // Textes légaux : BROUILLONS à faire valider par un juriste avant ouverture.
  legal: {
    mentions: "Le site douira.ma est édité par Douira (raison sociale, ICE, RC et adresse du siège à compléter), joignable à douira.services@gmail.com.\n\nHébergement : Render (serveur applicatif) et Supabase (base de données, Irlande). Directeur de la publication : à compléter.\n\nBrouillon à faire valider par un juriste avant mise en ligne.",
    cgu: "Douira met en relation des voyageurs et des logements à Marrakech. La réservation est confirmée après paiement en ligne sécurisé. Les informations d'accès (adresse exacte, code) sont communiquées au seul voyageur ayant réservé, après confirmation du paiement.\n\nBrouillon à faire valider par un juriste avant mise en ligne.",
    confidentialite: "Douira traite vos données (compte, réservations, échanges) pour la gestion de votre séjour, conformément à la loi 09-08 (CNDP) et, le cas échéant, au RGPD. Vous disposez d'un droit d'accès, de rectification et de suppression en écrivant à douira.services@gmail.com. Les données sont hébergées chez Supabase (Irlande).\n\nBrouillon à faire valider par un juriste avant mise en ligne.",
    annulation: "Trois politiques selon le logement : flexible (remboursement intégral jusqu'à 24 h avant l'arrivée), modérée (jusqu'à 5 jours avant), stricte (jusqu'à 14 jours avant). La politique applicable est indiquée sur chaque fiche.\n\nBrouillon à faire valider par un juriste avant mise en ligne."
  },

  // Textes de l'accueil.
  textes: {
    titre: 'Appartements et villas vérifiés à Marrakech.',
    introduction: "Guéliz, Hivernage, médina, Palmeraie : réservez en ligne, payez en dirhams, et recevez l'adresse, l'itinéraire et le code d'accès dès la confirmation. Notre équipe reste joignable pendant tout votre séjour.",
    proprietaires: "Confiez-nous votre appartement ou votre villa. Choisissez votre mode de gestion : autonome (vous gérez vos réservations et échangez avec les voyageurs) ou délégué (nous nous occupons de tout — réservations, encaissements, ménage et assistance). Vous suivez tout depuis votre espace propriétaire.",
    faq: [
      { q: 'Quand est-ce que je reçois l\'adresse et le code d\'accès ?', a: 'Dès la confirmation de votre paiement, puis de nouveau la veille de votre arrivée. Ces informations restent visibles pour vous seul, pendant la durée de votre séjour.' },
      { q: 'Dois-je payer des frais de ménage ?', a: 'Non. Le ménage est organisé entre chaque séjour et n\'est jamais facturé au voyageur.' },
      { q: 'Puis-je payer en euros ?', a: 'Le paiement se fait en dirhams (MAD). Un équivalent en euros est affiché à titre indicatif.' },
      { q: 'Comment annuler ma réservation ?', a: 'Chaque logement indique sa politique d\'annulation (flexible, modérée ou stricte). Vous pouvez annuler depuis votre espace ; le remboursement dépend de cette politique.' }
    ]
  },

  // Vos biens. Les photos sont des fichiers déposés dans le dossier « photos » du site.
  // Ne mettez JAMAIS ici l'adresse exacte ni le code d'accès : ce fichier est public.
  biens: [
    {
      id: '1', type: 'appartement',
      titre: 'Appartement lumineux près du Jardin Majorelle',
      ville: 'Marrakech', quartier: 'Guéliz', prixNuit: 750,
      voyageurs: 4, chambres: 2, sallesDeBain: 1, surface: 85,
      equipements: ['Wi-Fi', 'Climatisation', 'Cuisine équipée', 'Lave-linge', 'Ascenseur', 'Terrasse'],
      description: "Deux chambres calmes sur cour, salon traversant et terrasse plein sud. Le Jardin Majorelle est à 8 minutes à pied, la médina à 10 minutes en taxi.",
      reglement: 'Logement non-fumeur. Fêtes non autorisées. Calme après 22 h.',
      arrivee: '15:00', depart: '11:00', annulation: 'moderee', modeGestion: 'autonome',
      numeroAutorisation: '',
      positionApprox: { lat: 31.63702, lng: -8.01048 },
      diamond: false,
      remise: { pourcentage: 0, libelle: '', du: '', au: '' }
    },
    {
      id: '2', type: 'appartement',
      titre: 'Duplex avec terrasse et piscine partagée',
      ville: 'Marrakech', quartier: 'Hivernage', prixNuit: 1200,
      voyageurs: 6, chambres: 3, sallesDeBain: 2, surface: 140,
      equipements: ['Wi-Fi', 'Climatisation', 'Cuisine équipée', 'Piscine', 'Terrasse', 'Parking', 'Télévision'],
      description: "Duplex de 140 m² dans une résidence gardée avec piscine. Grande terrasse avec vue sur l'Atlas par temps clair, à deux pas des restaurants de l'Hivernage.",
      reglement: 'Logement non-fumeur. Fêtes non autorisées.',
      arrivee: '15:00', depart: '11:00', annulation: 'stricte', modeGestion: 'delegue',
      numeroAutorisation: '',
      positionApprox: { lat: 31.62154, lng: -8.01497 },
      diamond: false,
      remise: { pourcentage: 20, libelle: "Offre d'automne", du: '', au: '' }
    },
    {
      id: '3', type: 'appartement',
      titre: 'Studio moderne à deux pas de la gare',
      ville: 'Marrakech', quartier: 'Guéliz', prixNuit: 450,
      voyageurs: 2, chambres: 1, sallesDeBain: 1, surface: 38,
      equipements: ['Wi-Fi', 'Climatisation', 'Cuisine équipée', 'Espace de travail', 'Télévision'],
      description: "Studio rénové, idéal pour un déplacement professionnel ou un court séjour. Gare de Marrakech à 5 minutes à pied, cafés et restaurants de Guéliz au pied de l'immeuble.",
      reglement: 'Logement non-fumeur.',
      arrivee: '15:00', depart: '11:00', annulation: 'flexible', modeGestion: 'autonome',
      numeroAutorisation: '',
      positionApprox: { lat: 31.63051, lng: -8.01684 },
      diamond: false,
      remise: { pourcentage: 0, libelle: '', du: '', au: '' }
    },
    {
      id: '4', type: 'appartement',
      titre: "Appartement familial avec vue sur l'Atlas",
      ville: 'Marrakech', quartier: 'Agdal', prixNuit: 900,
      voyageurs: 5, chambres: 2, sallesDeBain: 2, surface: 110,
      equipements: ['Wi-Fi', 'Climatisation', 'Chauffage', 'Cuisine équipée', 'Lave-linge', 'Ascenseur', 'Parking'],
      description: "Grand séjour lumineux face à l'Atlas, deux chambres dont une avec lits jumeaux, parking en sous-sol. Jardins de l'Agdal et Menara Mall à proximité.",
      reglement: 'Logement non-fumeur. Fêtes non autorisées.',
      arrivee: '15:00', depart: '11:00', annulation: 'moderee', modeGestion: 'delegue',
      numeroAutorisation: '',
      positionApprox: { lat: 31.60452, lng: -7.99048 },
      diamond: false,
      remise: { pourcentage: 0, libelle: '', du: '', au: '' }
    },
    {
      id: '5', type: 'appartement',
      titre: 'Riad rénové au cœur de la médina',
      ville: 'Marrakech', quartier: 'Médina', prixNuit: 1100,
      voyageurs: 6, chambres: 3, sallesDeBain: 2, surface: 125,
      equipements: ['Wi-Fi', 'Climatisation', 'Chauffage', 'Cuisine équipée', 'Lave-linge', 'Terrasse'],
      description: "Trois chambres autour d'un patio planté, terrasse sur les toits avec vue sur la Koutoubia. Place Jemaa el-Fna à 8 minutes à pied.",
      reglement: 'Logement non-fumeur. Calme après 22 h.',
      arrivee: '15:00', depart: '11:00', annulation: 'moderee', modeGestion: 'delegue',
      numeroAutorisation: '',
      positionApprox: { lat: 31.62303, lng: -7.98702 },
      diamond: false,
      remise: { pourcentage: 10, libelle: 'Séjours en famille', du: '', au: '' }
    },
    {
      id: '6', type: 'villa',
      titre: 'Villa avec piscine privée dans la Palmeraie',
      ville: 'Marrakech', quartier: 'Palmeraie', prixNuit: 3200,
      voyageurs: 10, chambres: 5, sallesDeBain: 4, surface: 380,
      equipements: ['Wi-Fi', 'Climatisation', 'Cuisine équipée', 'Piscine privée', 'Jardin', 'Barbecue', 'Terrasse', 'Gardien', 'Hammam', 'Parking'],
      description: "Villa de 380 m² sur un jardin de palmiers et d'oliviers. Piscine chauffée de 12 m, hammam, cinq suites. À 20 minutes du centre de Marrakech.",
      reglement: "Fêtes et événements soumis à accord préalable. Non-fumeur à l'intérieur. Calme après 23 h.",
      arrivee: '15:00', depart: '11:00', annulation: 'stricte', modeGestion: 'autonome',
      numeroAutorisation: '',
      positionApprox: { lat: 31.67503, lng: -7.97498 },
      diamond: true,
      remise: { pourcentage: 0, libelle: '', du: '', au: '' }
    }
  ],

  // Activités à proximité (affichées dans « À proximité » sur la fiche d'un bien, triées par distance).
  // categorie : 'culture', 'souks', 'gastronomie', 'bienetre', 'excursions', 'sport' ou 'pratique'.
  activites: [
    { nom: 'Jardin Majorelle', categorie: 'culture', position: { lat: 31.64173, lng: -8.00328 }, prix: 170, note: "Jardin d'Yves Saint Laurent et musée berbère." },
    { nom: 'Place Jemaa el-Fna', categorie: 'culture', position: { lat: 31.62577, lng: -7.98915 }, prix: 0, note: 'Cœur de la médina, animée à la nuit tombée.' },
    { nom: 'Mosquée Koutoubia', categorie: 'culture', position: { lat: 31.62376, lng: -7.99335 }, prix: 0, note: 'Minaret emblématique (extérieur et jardins).' },
    { nom: 'Palais de la Bahia', categorie: 'culture', position: { lat: 31.62183, lng: -7.98303 }, prix: 100, note: 'Palais du XIXᵉ, patios et plafonds peints.' },
    { nom: 'Souk Semmarine', categorie: 'souks', position: { lat: 31.62952, lng: -7.98760 }, prix: 0, note: 'Artisanat, cuir, épices, tapis.' },
    { nom: 'Jardin de la Ménara', categorie: 'culture', position: { lat: 31.61111, lng: -8.02083 }, prix: 0, note: "Bassin et pavillon face à l'Atlas." },
    { nom: 'Hammam traditionnel, Guéliz', categorie: 'bienetre', position: { lat: 31.63500, lng: -8.01000 }, prix: 250, note: 'Gommage et soins, sur réservation.' },
    { nom: "Désert d'Agafay", categorie: 'excursions', position: { lat: 31.46000, lng: -8.15000 }, prix: 600, note: 'Dîner et nuit sous tente à 40 min de la ville.' },
    { nom: "Vallée de l'Ourika", categorie: 'excursions', position: { lat: 31.36000, lng: -7.70000 }, prix: 400, note: "Cascades et villages de l'Atlas, à la journée." },
    { nom: 'Golf Amelkis', categorie: 'sport', position: { lat: 31.59000, lng: -7.95500 }, prix: 700, note: 'Parcours 18 trous au sud de la ville.' }
  ],

  // Véhicules proposés en option dans les demandes (facultatif).
  vehicules: [
    /* { type: 'voiture', nom: 'Renault Clio automatique', description: '5 places, essence', prixJour: 420, caution: 4000, photo: 'photos/clio.jpg' }, */
  ]
};
