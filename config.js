/* =====================================================================
   DOUIRA · configuration du site en ligne
   C'est le seul fichier à modifier avant la mise en ligne.
   Enregistrez-le en UTF-8. Les textes vont entre guillemets.
   Tant qu'un champ est vide, le site l'indique dans la console du
   navigateur (F12 → Console) : « À compléter dans config.js ».
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
  whatsapp: '',           // numéro qui reçoit les demandes, ex. '+212 6 12 34 56 78'
  // E-mail de l'administrateur : reçoit les demandes envoyées par e-mail et
  // s'affiche sur le site comme adresse de contact. Modifiable à tout moment :
  // changez l'adresse ci-dessous puis renvoyez ce seul fichier chez l'hébergeur.
  email: 'douira.services@gmail.com',
  villes: ['Marrakech'],
  markupPct: 12.5,        // majoration appliquée au prix du propriétaire (jamais affichée)

  // Fond de la carte des logements. Vide : OpenStreetMap (gratuit, sans clé ; la mention
  // « © les contributeurs d'OpenStreetMap » reste affichée sur la carte).
  // Avec beaucoup de visiteurs, prenez un fournisseur de cartes et collez ici l'adresse
  // de tuiles (format …/{z}/{x}/{y}.png avec votre clé) et la mention qu'il demande.
  carte: {
    tuiles: '',
    attribution: ''
  },

  societe: {
    raisonSociale: '',    // ex. 'Douira SARL'
    ice: '',
    rc: '',
    adresse: '',
    cndp: ''              // n° de récépissé ou d'autorisation CNDP
  },

  // Textes légaux validés par votre juriste. Séparez les paragraphes par une ligne vide.
  legal: {
    mentions: '',
    cgu: '',
    confidentialite: '',
    annulation: ''
  },

  // Textes de l'accueil (facultatif : sinon des textes par défaut sont utilisés).
  textes: {
    titre: '',
    introduction: '',
    proprietaires: '',
    faq: []               // ex. [{ q: 'Question ?', a: 'Réponse.' }]
  },

  // Vos biens. Les photos sont des fichiers déposés dans le dossier « photos » du site.
  // Ne mettez JAMAIS ici l'adresse exacte ni le code d'accès : ce fichier est public.
  biens: [
    /* Exemple de format (à recopier sans les barres obliques et astérisques) :
    {
      id: '1',
      type: 'appartement',          // 'appartement' ou 'villa'
      titre: 'Appartement 2 chambres à Guéliz',
      ville: 'Marrakech',
      quartier: 'Guéliz',
      prixNuit: 700,                // prix du propriétaire en MAD ; le site affiche +12,5 %
      voyageurs: 4, chambres: 2, sallesDeBain: 1, surface: 80,
      equipements: ['Wi-Fi', 'Climatisation', 'Cuisine équipée'],
      description: 'Texte de présentation du logement.',
      reglement: 'Logement non-fumeur.',
      arrivee: '15:00', depart: '11:00',
      annulation: 'moderee',        // 'flexible', 'moderee' ou 'stricte'
      numeroAutorisation: '',       // n° d'autorisation ou de déclaration (loi 80-14)
      photos: ['photos/bien-1-salon.jpg', 'photos/bien-1-chambre.jpg'],
      positionApprox: { lat: 31.637, lng: -8.010 },   // centre du quartier, pas l'adresse
      diamond: false,
      remise: { pourcentage: 0, libelle: '', du: '', au: '' }   // dates au format 'AAAA-MM-JJ'
    },
    */
  ],

  // Véhicules proposés en option dans les demandes (facultatif).
  vehicules: [
    /* { type: 'voiture', nom: 'Renault Clio automatique', description: '5 places, essence', prixJour: 420, caution: 4000, photo: 'photos/clio.jpg' }, */
  ]
};
