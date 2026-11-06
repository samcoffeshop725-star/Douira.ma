/* =====================================================================
   Comparaison faciale automatique : la réponse à la minute.

   Faire attendre vingt-quatre heures quelqu'un qui veut louer une voiture
   maintenant, c'est le perdre. Ce module rend donc un verdict en quelques
   secondes — mais sous une règle qui ne se négocie pas :

     IL PEUT ACCEPTER SEUL. IL NE PEUT JAMAIS REFUSER SEUL.

   Tout ce qui n'est pas une concordance franche part à l'examen humain. Deux
   raisons, et chacune suffirait. D'abord le droit : refuser l'accès à un
   service par une décision entièrement automatisée, sans recours humain, est
   interdit (RGPD, article 22). Ensuite les faits : les vrais clients échouent
   aussi — jumeaux, photo de passeport d'il y a dix ans, mauvaise lumière,
   voile, chirurgie. Un robot qui refuse tout seul perd des clients honnêtes
   et ne vous le dit jamais.

   CE QUE CE MODULE NE FAIT PAS. Il ne détecte pas la VIVACITÉ : il compare
   deux images, et une photo d'une photo est une image comme une autre.
   Contre un fraudeur décidé, il ne vaut pas mieux que l'œil humain — il est
   seulement plus rapide. La vivacité demande un prestataire spécialisé
   (voir api/docs/VERIFICATION-IDENTITE.md, § 3).

   PILOTES DISPONIBLES
     humain      : aucun automatisme, l'équipe tranche (défaut)
     rekognition : Amazon Rekognition CompareFaces, à la carte
     simulate    : essais locaux seulement — REFUSÉ en production

   Réglage par variables d'environnement, comme le prestataire de paiement :
     KYC_PROVIDER=rekognition
     AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
     KYC_MIN_SIMILARITY (défaut 99)
   ===================================================================== */
'use strict';
const crypto = require('crypto');

/**
 * Seuil d'acceptation automatique, en pourcentage de similarité.
 *
 * 99 par défaut, qui est la valeur recommandée par AWS pour un usage
 * d'identité — pas 80, qui laisserait passer des visages qui se ressemblent.
 * Baisser ce seuil, c'est accepter davantage d'imposteurs ; le monter, c'est
 * envoyer davantage de clients honnêtes à l'examen humain. Jamais au-dessous
 * de 90 : en dessous, le chiffre ne veut plus rien dire pour une identité.
 */
function seuil() {
  const v = Number(process.env.KYC_MIN_SIMILARITY);
  if (!Number.isFinite(v)) return 99;
  return Math.min(100, Math.max(90, v));
}

/** Le pilote en vigueur. « humain » dès que le réglage est absent ou inconnu. */
function pilote() {
  const p = String(process.env.KYC_PROVIDER || 'humain').trim().toLowerCase();
  if (p === 'simulate' && process.env.NODE_ENV === 'production') {
    // Même règle que le paiement simulé : jamais en production. Un verdict
    // d'identité inventé y serait un mensonge sur une personne réelle.
    console.error('KYC_PROVIDER=simulate refusé en production : retour à l’examen humain.');
    return 'humain';
  }
  if (!['humain', 'rekognition', 'simulate'].includes(p)) {
    console.error(`KYC_PROVIDER inconnu (${p}) : retour à l’examen humain.`);
    return 'humain';
  }
  if (p === 'rekognition' && !(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)) {
    console.error('KYC_PROVIDER=rekognition sans identifiants AWS : retour à l’examen humain.');
    return 'humain';
  }
  return p;
}

/** Y a-t-il un automatisme ? L'appelant adapte son message d'attente. */
const automatique = () => pilote() !== 'humain';

/* ---------------- La décision, à partir d'une mesure ----------------

   Fonction pure : c'est elle qui porte la règle, et elle se teste sans réseau
   ni clé. Les pilotes ne font que produire la mesure. */

/**
 * Traduit une mesure en décision.
 *
 * @param m  { visages: nombre de visages sur le selfie,
 *             piece: un visage a-t-il été trouvé sur la pièce,
 *             similarite: 0–100 ou null }
 * @returns  { issue: 'passed' | 'review' | 'retry', reason }
 *
 *   'retry'  : la photo est inexploitable. Rien n'est enregistré, rien n'est
 *              décompté, le client recommence tout de suite.
 *   'review' : un humain regarde. C'est le cas par défaut de tout doute.
 *   'passed' : concordance franche.
 */
function decision(m, min) {
  const seuilUtile = Number.isFinite(min) ? min : seuil();
  const mesure = m || {};

  // Rien d'exploitable : on le dit au client plutôt que de faire perdre son
  // temps à l'équipe. Ce n'est pas un échec, c'est une photo à refaire.
  if (!mesure.visages) {
    return { issue: 'retry', reason: 'Aucun visage n’a été reconnu sur la photo. Placez-vous face à l’appareil, dans un endroit éclairé.' };
  }
  if (mesure.visages > 1) {
    return { issue: 'retry', reason: 'Plusieurs visages sur la photo. Prenez-la seul.' };
  }

  // La pièce n'a pas livré de portrait exploitable : ce n'est pas la faute du
  // client, et surtout ce n'est pas une raison de le refuser.
  if (!mesure.piece) {
    return { issue: 'review', reason: 'Portrait de la pièce illisible automatiquement.' };
  }

  if (mesure.similarite != null && mesure.similarite >= seuilUtile) {
    return { issue: 'passed', reason: '' };
  }

  // Sous le seuil : ON NE REFUSE PAS. Un humain tranchera.
  return { issue: 'review', reason: 'Concordance insuffisante pour une décision automatique.' };
}

/* ---------------- Signature AWS (SigV4) ----------------

   Écrite à la main plutôt qu'avec le SDK : le serveur n'a qu'une dépendance
   obligatoire, et en ajouter une de plusieurs mégaoctets pour un seul appel
   serait disproportionné. Quatre-vingts lignes, et rien à mettre à jour. */

const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (key, v) => crypto.createHmac('sha256', key).update(v).digest();

function signer(region, service, body, target) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const jour = amzDate.slice(0, 8);
  const host = `${service}.${region}.amazonaws.com`;

  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': target,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  const canonical = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');

  const scope = `${jour}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');

  let k = hmac('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, jour);
  k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');

  return {
    url: `https://${host}/`,
    headers: Object.assign({}, headers, {
      authorization: `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }),
  };
}

/* ---------------- Les pilotes ---------------- */

/**
 * Amazon Rekognition : CompareFaces.
 *
 * `SimilarityThreshold` est volontairement bas dans la requête (80) : on veut
 * CONNAÎTRE la similarité même quand elle est faible, pour que `decision`
 * tranche selon notre règle et non celle d'AWS. Ce qui décide reste ici.
 */
async function parRekognition(selfie, piece) {
  const region = String(process.env.AWS_REGION || 'eu-west-1');
  const body = JSON.stringify({
    SourceImage: { Bytes: selfie.toString('base64') },
    TargetImage: { Bytes: piece.toString('base64') },
    SimilarityThreshold: 80,
    QualityFilter: 'AUTO',
  });
  const s = signer(region, 'rekognition', body, 'RekognitionService.CompareFaces');

  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), 12000);
  let r;
  try {
    r = await fetch(s.url, { method: 'POST', headers: s.headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(minuteur);
  }

  const texte = await r.text();
  if (!r.ok) {
    let type = '';
    try { type = JSON.parse(texte).__type || ''; } catch (e) { /* corps illisible */ }
    // Pas de visage sur la photo source : Rekognition le dit par une erreur,
    // alors que c'est un cas normal — le client refait sa photo.
    if (/InvalidParameterException/.test(type)) return { visages: 0, piece: false, similarite: null };
    throw new Error(`Rekognition ${r.status} ${type}`.trim());
  }

  const j = JSON.parse(texte);
  const matches = Array.isArray(j.FaceMatches) ? j.FaceMatches : [];
  const autres = Array.isArray(j.UnmatchedFaces) ? j.UnmatchedFaces : [];
  return {
    // SourceImage = le selfie : AWS n'en retient qu'un visage, le plus grand.
    visages: j.SourceImageFace ? 1 : 0,
    // La cible est la pièce : un visage y a-t-il été trouvé, concordant ou non ?
    piece: matches.length + autres.length > 0,
    similarite: matches.length ? Number(matches[0].Similarity) : 0,
  };
}

/**
 * Pilote d'essai : AUCUNE comparaison réelle.
 *
 * Il sert à éprouver le parcours — l'attente, l'écran de résultat, le
 * renvoi vers l'examen humain — sur une machine de développement. Il ne
 * regarde pas les visages, et le verdict qu'il rend porte cette mention
 * jusque dans la base. Refusé en production par `pilote()`.
 */
async function parSimulation(selfie, piece) {
  // Une image minuscule ne contient pas un visage : on rend « à refaire »,
  // ce qui permet d'éprouver aussi ce chemin-là.
  if (!selfie || selfie.length < 1024) return { visages: 0, piece: false, similarite: null };
  if (!piece || piece.length < 1024) return { visages: 1, piece: false, similarite: null };
  return { visages: 1, piece: true, similarite: 100 };
}

/**
 * Compare, et rend une décision.
 *
 * Toute panne du prestataire rend 'review' : un service injoignable ne vaut
 * jamais acceptation, et ne doit pas non plus refuser quelqu'un.
 */
async function comparer(selfie, piece) {
  const p = pilote();
  if (p === 'humain') return { issue: 'review', reason: '', provider: 'humain', mesure: null };

  try {
    const mesure = p === 'rekognition' ? await parRekognition(selfie, piece) : await parSimulation(selfie, piece);
    const d = decision(mesure);
    return {
      issue: d.issue,
      reason: p === 'simulate' && d.issue === 'passed'
        ? 'Vérification simulée : aucune comparaison réelle.'
        : d.reason,
      provider: p,
      mesure,
    };
  } catch (e) {
    console.error('Comparaison faciale indisponible :', e.message);
    return { issue: 'review', reason: 'Comparaison automatique indisponible.', provider: p, mesure: null };
  }
}

module.exports = { pilote, automatique, seuil, decision, comparer };
