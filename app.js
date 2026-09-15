/*
 * Panneau de contrôle « Vidéo du jour ».
 *
 * Page statique, sans dépendance externe. Elle ne contient AUCUN secret : le
 * jeton d'accès (PAT) est collé une fois par l'utilisateur et reste dans le
 * stockage local de SON navigateur — jamais envoyé ailleurs qu'à l'API GitHub.
 *
 * === Le piège du téléchargement de la vidéo, et pourquoi ce code l'évite ===
 * L'asset d'une Release GitHub se télécharge via une redirection vers Azure
 * Blob Storage, et cette réponse finale NE RENVOIE AUCUN EN-TÊTE CORS —
 * vérifié. Un fetch() depuis cette page échouerait donc systématiquement, avec
 * un « Failed to fetch » sans aucun indice de la cause.
 * Le mécanisme qui fonctionne : un fichier SUIVI PAR GIT expose, via l'API
 * Contents, un `download_url` qui porte un jeton signé DANS L'URL. fetch() peut
 * l'appeler SANS AUCUN EN-TÊTE — donc sans préflight CORS, la seule chose qui
 * casse sur ce chemin.
 *
 * === Pourquoi l'éditeur ne passe pas par un analyseur YAML ===
 * `config.yaml` et `theme.yaml` sont massivement commentés, et ces commentaires
 * SONT la documentation du projet. Charger le YAML dans un objet puis le
 * réécrire les effacerait tous, silencieusement. L'éditeur ci-dessous fait donc
 * des remplacements CHIRURGICAUX : il localise la ligne d'une clé et ne
 * substitue que la valeur, laissant l'indentation, l'ordre et les commentaires
 * — y compris celui en fin de ligne — exactement où ils étaient.
 */

const OWNER = "ihsankrpz";
const REPO = "Tiktok_Auto";
const WORKFLOW_FILE = "video.yml";
const BRANCHE_RESULTAT = "dernier-resultat";
const API_BASE = "https://api.github.com";

const CLE_PAT = "vdj_pat";
const CLE_DERNIER_RUN = "vdj_dernier_run_id";
const CLE_THEME = "vdj_theme";

const LIBELLES_ECRAN = {
  lancer: "Panneau de contrôle",
  resultat: "Dernier résultat",
  editer: "Éditer",
  reglages: "Réglages",
};

const PICTOS_STATUT = { OK: "🟢", AVERTISSEMENT: "🟠", ECHEC: "🔴" };
const PICTOS_VERDICT = { PUBLIABLE: "🟢", A_VERIFIER: "🟠", ECHEC: "🔴" };

const etat = {
  suivi: null,
  dernierRun: null,
  minuteurSondage: null,
  minuteurAffichage: null,
};

// --------------------------------------------------------------------------
// Ce que le formulaire expose. Tout le reste reste accessible en « Avancé ».
// --------------------------------------------------------------------------
const SCHEMA = {
  theme: {
    fichier: "theme.yaml",
    champs: [
      { cle: "libelle", type: "texte", libelle: "Nom du thème",
        aide: "Affiché dans les rapports, les Releases et le titre des résultats." },
      { cle: "ton", type: "texte", libelle: "Ton",
        aide: "Une phrase décrivant la voix éditoriale. Reprise telle quelle dans le prompt." },
      { cle: "description", type: "bloc", libelle: "Cadrage",
        aide: "Le cadrage complet envoyé au modèle. Une idée par ligne." },
      { cle: "angles_a_privilegier", type: "liste-tirets", libelle: "Angles à privilégier",
        aide: "Un par ligne. Le modèle en choisit un par vidéo, en évitant ceux déjà traités." },
      { cle: "angles_interdits", type: "liste-tirets", libelle: "Angles interdits",
        aide: "Un par ligne. Transmis au modèle comme interdits explicites." },
      { cle: "mots_cles_secours", type: "liste-tirets", libelle: "Mots-clés de secours",
        aide: "EN ANGLAIS. Servent à remplir la banque d'images du thème. S'ils ne ramènent rien sur Pexels ni Pixabay, un thème neuf ne pourra pas démarrer." },
      { cle: "marques_surveillees", type: "liste-tirets", libelle: "Marques surveillées",
        aide: "Un plan dont la description en contient une lève un avertissement de droits." },
      { cle: "hashtags_socle", type: "liste-inline", libelle: "Hashtags de base",
        aide: "Sur chaque vidéo, avant les hashtags de niche que le modèle ajoute." },
      { cle: "ambiances_musique", type: "liste-inline", libelle: "Ambiances musicales",
        aide: "EN ANGLAIS. Départagent les morceaux de la banque en mode auto." },
      { cle: "voix_tts", type: "texte", libelle: "Voix",
        aide: "Nom ou identifiant ElevenLabs. Celle du thème prime sur celle des réglages." },
    ],
  },
  reglages: {
    fichier: "config.yaml",
    champs: [
      { cle: "voix_active", type: "bool", libelle: "Voix off",
        aide: "Éteinte : AUCUN appel à ElevenLabs, piste silencieuse et repères de sous-titres calculés. La vidéo sort complète mais sans commentaire." },
      { cle: "modeles.actif", type: "bool", libelle: "Écriture par le modèle",
        aide: "Éteinte : aucun appel à Anthropic. Le script vient alors de `script_manuel` dans config.yaml." },
      { cle: "mode_audio", type: "choix", libelle: "Musique",
        options: [
          ["auto", "Auto — le morceau le plus adéquat de la banque"],
          ["elevenlabs", "ElevenLabs — composé sur mesure (palier payant)"],
          ["manuel", "Manuel — le morceau nommé ci-dessous"],
          ["desactive", "Désactivée — aucune musique, aucun appel"],
        ],
        aide: "« elevenlabs » retombe sur « auto » si le palier du compte n'inclut pas l'API Musique." },
      { cle: "musique_manuelle", type: "texte", libelle: "Morceau imposé",
        aide: "Lu uniquement en mode Manuel. Nom de fichier tel qu'il apparaît dans la banque." },
      { cle: "bruitages.actif", type: "bool", libelle: "Bruitages",
        aide: "Un accent sonore aux changements de segment. Consomme l'API ElevenLabs." },
      { cle: "duree_cible_video_s", type: "nombre", libelle: "Durée visée (secondes)",
        aide: "Tout en découle : nombre de mots, de segments, de plans. Changer cette seule valeur suffit." },
      { cle: "secours_auto", type: "bool", libelle: "Remplir la banque de secours",
        aide: "Éteint, un thème neuf échouera au lieu de télécharger ses clips tout seul." },
      { cle: "video_sponsorisee", type: "bool", libelle: "Vidéo sponsorisée",
        aide: "Ajoute la mention de partenariat rémunéré dans la description." },
    ],
  },
};

// État de l'éditeur : contenu brut et sha par fichier, valeurs d'origine.
const editeur = {
  fichiers: {},          // nom -> { texte, sha }
  origine: {},           // "fichier|cle" -> valeur lue au chargement
  voletActuel: "theme",
  fichierBrut: "theme.yaml",
};

// --------------------------------------------------------------------------
// Utilitaires généraux
// --------------------------------------------------------------------------
function attendre(ms) { return new Promise((r) => setTimeout(r, ms)); }
function obtenirPat() { return (localStorage.getItem(CLE_PAT) || "").trim(); }

function decoderBase64Utf8(b64) {
  const binaire = atob(b64.replace(/\n/g, ""));
  const octets = Uint8Array.from(binaire, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(octets);
}

function encoderBase64Utf8(texte) {
  const octets = new TextEncoder().encode(texte);
  let binaire = "";
  octets.forEach((o) => { binaire += String.fromCharCode(o); });
  return btoa(binaire);
}

function formaterDuree(secondes) {
  const s = Math.max(0, Math.round(secondes));
  const min = Math.floor(s / 60);
  return min > 0 ? `${min} min ${s % 60}s` : `${s}s`;
}

function afficherAvis(cible, type, texte) {
  const conteneur = typeof cible === "string" ? document.getElementById(cible) : cible;
  conteneur.innerHTML = "";
  const div = document.createElement("div");
  div.className = "avis " + type;
  div.textContent = texte;
  conteneur.appendChild(div);
}

function explicationErreur(e) {
  if (e && e.status === 401) return "Jeton invalide ou expiré — va dans Réglages pour le renouveler.";
  if (e && e.status === 403) return "Accès refusé — vérifie que le jeton couvre Actions et Contents en lecture/écriture sur Tiktok_Auto.";
  if (e && e.status === 404) return "Introuvable — vérifie que le jeton a bien accès au dépôt Tiktok_Auto.";
  if (e && e.status === 409) return "Conflit : le fichier a changé entre-temps sur GitHub.";
  if (e && e.status === 422) return "Requête refusée par GitHub : " + e.message;
  return (e && e.message) || "Erreur inconnue.";
}

async function copierPresse(texte, idBouton) {
  try {
    await navigator.clipboard.writeText(texte);
  } catch {
    const zone = document.createElement("textarea");
    zone.value = texte;
    zone.style.position = "fixed";
    zone.style.opacity = "0";
    document.body.appendChild(zone);
    zone.select();
    try { document.execCommand("copy"); } catch { /* tant pis */ }
    zone.remove();
  }
  const bouton = document.getElementById(idBouton);
  if (bouton) {
    const original = bouton.textContent;
    bouton.textContent = "Copié ✓";
    setTimeout(() => { bouton.textContent = original; }, 1500);
  }
}

// --------------------------------------------------------------------------
// YAML chirurgical — on ne touche QUE la valeur, jamais les commentaires
// --------------------------------------------------------------------------
function _echapperRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Les fichiers du projet sont en CRLF. Un simple split("\n") laisserait un \r
// en fin de chaque ligne, et toute regex ancrée sur $ échouerait — en rendant
// « clé introuvable » pour les listes et les clés imbriquées, silencieusement.
// On découpe donc sur /\r?\n/ et l'on RESTITUE le style d'origine au
// rassemblage : réécrire en LF produirait un diff de toutes les lignes du
// fichier pour un seul champ modifié.
function _decouper(texte) {
  return { lignes: texte.split(/\r?\n/), finLigne: texte.includes("\r\n") ? "\r\n" : "\n" };
}

function _deciter(brut) {
  const t = brut.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Une valeur scalaire est soit entre guillemets, soit un jeton sans `#`. Le
// groupe de fin capture les espaces ET le commentaire de fin de ligne, qu'on
// réinjecte tels quels.
function _regexScalaire(cle, indentation) {
  const debut = indentation === undefined ? "^" : `^${indentation}`;
  return new RegExp(
    `${debut}(${_echapperRegex(cle)}:[ \\t]*)("[^"]*"|'[^']*'|[^#\\r\\n]*?)([ \\t]*(?:#.*)?)$`,
    "m");
}

function lireScalaire(texte, cle) {
  const m = texte.match(_regexScalaire(cle));
  return m ? _deciter(m[2]) : null;
}

function ecrireScalaire(texte, cle, valeurRendue) {
  const re = _regexScalaire(cle);
  if (!re.test(texte)) throw new Error(`Clé « ${cle} » introuvable dans le fichier.`);
  return texte.replace(re, (_, prefixe, __, reste) => prefixe + valeurRendue + reste);
}

// Bornes du corps indenté d'un bloc `parent:` — sert aux clés imbriquées.
function _bornesBloc(lignes, parent) {
  const re = new RegExp(`^${_echapperRegex(parent)}:`);
  const debut = lignes.findIndex((l) => re.test(l));
  if (debut < 0) return null;
  let fin = debut + 1;
  while (fin < lignes.length && (lignes[fin].trim() === "" || /^\s/.test(lignes[fin]))) fin++;
  return { debut, fin };
}

function lireImbrique(texte, parent, enfant) {
  const { lignes, finLigne } = _decouper(texte);
  const bornes = _bornesBloc(lignes, parent);
  if (!bornes) return null;
  const re = new RegExp(`^\\s+${_echapperRegex(enfant)}:[ \\t]*("[^"]*"|'[^']*'|[^#\\r\\n]*?)[ \\t]*(?:#.*)?$`);
  for (let i = bornes.debut + 1; i < bornes.fin; i++) {
    const m = lignes[i].match(re);
    if (m) return _deciter(m[1]);
  }
  return null;
}

function ecrireImbrique(texte, parent, enfant, valeurRendue) {
  const { lignes, finLigne } = _decouper(texte);
  const bornes = _bornesBloc(lignes, parent);
  if (!bornes) throw new Error(`Bloc « ${parent} » introuvable.`);
  const re = new RegExp(`^(\\s+${_echapperRegex(enfant)}:[ \\t]*)("[^"]*"|'[^']*'|[^#\\r\\n]*?)([ \\t]*(?:#.*)?)$`);
  for (let i = bornes.debut + 1; i < bornes.fin; i++) {
    if (re.test(lignes[i])) {
      lignes[i] = lignes[i].replace(re, (_, p, __, reste) => p + valeurRendue + reste);
      return lignes.join(finLigne);
    }
  }
  throw new Error(`Clé « ${parent}.${enfant} » introuvable.`);
}

function lireListeInline(texte, cle) {
  const m = texte.match(new RegExp(`^${_echapperRegex(cle)}:[ \\t]*\\[([^\\]]*)\\]`, "m"));
  if (!m) return null;
  return m[1].split(",").map((s) => _deciter(s)).filter((s) => s !== "");
}

function ecrireListeInline(texte, cle, items) {
  const re = new RegExp(`^(${_echapperRegex(cle)}:[ \\t]*)\\[[^\\]]*\\]`, "m");
  if (!re.test(texte)) throw new Error(`Liste « ${cle} » introuvable.`);
  const rendu = "[" + items.map((s) => JSON.stringify(s)).join(", ") + "]";
  return texte.replace(re, (_, prefixe) => prefixe + rendu);
}

function lireListeTirets(texte, cle) {
  const { lignes, finLigne } = _decouper(texte);
  const re = new RegExp(`^${_echapperRegex(cle)}:[ \\t]*(#.*)?$`);
  const i = lignes.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const items = [];
  for (let j = i + 1; j < lignes.length; j++) {
    const m = lignes[j].match(/^\s+-\s+(.*?)\s*$/);
    if (!m) break;
    items.push(_deciter(m[1]));
  }
  return items;
}

function ecrireListeTirets(texte, cle, items) {
  const { lignes, finLigne } = _decouper(texte);
  const re = new RegExp(`^${_echapperRegex(cle)}:[ \\t]*(#.*)?$`);
  const i = lignes.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`Liste « ${cle} » introuvable.`);
  let fin = i + 1;
  let indentation = "  ";
  while (fin < lignes.length) {
    const m = lignes[fin].match(/^(\s+)-\s/);
    if (!m) break;
    indentation = m[1];
    fin++;
  }
  const rendu = items.map((s) => `${indentation}- ${JSON.stringify(s)}`);
  lignes.splice(i + 1, fin - (i + 1), ...rendu);
  return lignes.join(finLigne);
}

// Bloc replié `cle: >` — les lignes suivantes, indentées. YAML les recolle
// avec des espaces, donc l'endroit où l'on coupe les lignes ne change rien au
// sens : on les conserve telles quelles pour rester prévisible.
function lireBloc(texte, cle) {
  const { lignes, finLigne } = _decouper(texte);
  const re = new RegExp(`^${_echapperRegex(cle)}:[ \\t]*[>|][-+]?[ \\t]*$`);
  const i = lignes.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const corps = [];
  for (let j = i + 1; j < lignes.length; j++) {
    if (/^\s+\S/.test(lignes[j])) corps.push(lignes[j].trim());
    else break;
  }
  return corps.join("\n");
}

function ecrireBloc(texte, cle, contenu) {
  const { lignes, finLigne } = _decouper(texte);
  const re = new RegExp(`^${_echapperRegex(cle)}:[ \\t]*[>|][-+]?[ \\t]*$`);
  const i = lignes.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`Bloc « ${cle} » introuvable.`);
  let fin = i + 1;
  let indentation = "  ";
  while (fin < lignes.length && /^\s+\S/.test(lignes[fin])) {
    const m = lignes[fin].match(/^(\s+)/);
    if (m) indentation = m[1];
    fin++;
  }
  const rendu = contenu.split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => indentation + l);
  lignes.splice(i + 1, fin - (i + 1), ...rendu);
  return lignes.join(finLigne);
}

// Aiguillage lecture / écriture selon le type déclaré au SCHEMA.
function lireChamp(texte, champ) {
  if (champ.cle.includes(".")) {
    const [parent, enfant] = champ.cle.split(".");
    return lireImbrique(texte, parent, enfant);
  }
  if (champ.type === "liste-inline") return lireListeInline(texte, champ.cle);
  if (champ.type === "liste-tirets") return lireListeTirets(texte, champ.cle);
  if (champ.type === "bloc") return lireBloc(texte, champ.cle);
  return lireScalaire(texte, champ.cle);
}

function ecrireChamp(texte, champ, valeur) {
  if (champ.type === "liste-inline") return ecrireListeInline(texte, champ.cle, valeur);
  if (champ.type === "liste-tirets") return ecrireListeTirets(texte, champ.cle, valeur);
  if (champ.type === "bloc") return ecrireBloc(texte, champ.cle, valeur);

  let rendu;
  // `valeur` arrive en booleen (depuis l'interrupteur) ou en chaine (depuis
  // une relecture du fichier). "false" etant une chaine NON VIDE, donc
  // truthy, un simple `valeur ? ...` renverrait true et INVERSERAIT le
  // reglage au lieu de le conserver.
  if (champ.type === "bool") rendu = (valeur === true || valeur === "true") ? "true" : "false";
  else if (champ.type === "nombre") rendu = String(valeur);
  else rendu = JSON.stringify(String(valeur));

  if (champ.cle.includes(".")) {
    const [parent, enfant] = champ.cle.split(".");
    return ecrireImbrique(texte, parent, enfant, rendu);
  }
  return ecrireScalaire(texte, champ.cle, rendu);
}

// --------------------------------------------------------------------------
// Appels à l'API GitHub
// --------------------------------------------------------------------------
async function ghApi(chemin, options = {}) {
  const opts = {
    method: options.method || "GET",
    headers: {
      "Authorization": "Bearer " + obtenirPat(),
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
  if (options.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = options.body;
  }
  const reponse = await fetch(API_BASE + chemin, opts);
  if (!reponse.ok) {
    let message = `HTTP ${reponse.status}`;
    try {
      const d = await reponse.json();
      if (d && d.message) message += " — " + d.message;
    } catch { /* corps non JSON */ }
    const erreur = new Error(message);
    erreur.status = reponse.status;
    throw erreur;
  }
  return reponse;
}

// --------------------------------------------------------------------------
// Écran LANCER
// --------------------------------------------------------------------------
async function idDuDernierRun() {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`);
  const d = await r.json();
  return (d.workflow_runs[0] && d.workflow_runs[0].id) || 0;
}

// L'API workflow_dispatch ne renvoie AUCUN identifiant du run créé (juste un
// 204). On note l'id du run le plus récent AVANT de déclencher, puis on guette
// l'apparition d'un run dont l'id dépasse celui-là — sans ambiguïté d'horloge.
async function lancer(mode, forcer) {
  const avant = await idDuDernierRun();
  await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { mode, force: forcer ? "true" : "false" } }),
  });
  for (let essai = 0; essai < 20; essai++) {
    await attendre(3000);
    const r = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`);
    const d = await r.json();
    const nouveau = d.workflow_runs.find((x) => x.id > avant);
    if (nouveau) return nouveau.id;
  }
  throw new Error("Le run n'est pas apparu après une minute — vérifie l'onglet Actions sur github.com.");
}

async function lancerVideo(mode) {
  document.getElementById("bouton-lancer-production").disabled = true;
  document.getElementById("bouton-lancer-essai").disabled = true;
  const zoneAvis = document.getElementById("lancer-avis");
  afficherAvis(zoneAvis, "info", "Déclenchement du run…");
  try {
    const forcer = document.getElementById("case-forcer").checked;
    const idNouveau = await lancer(mode, forcer);
    afficherAvis(zoneAvis, "ok", "Run lancé — suivi ci-dessus.");
    demarrerSuivi(idNouveau);
  } catch (e) {
    afficherAvis(zoneAvis, "erreur", explicationErreur(e));
  } finally {
    document.getElementById("bouton-lancer-production").disabled = false;
    document.getElementById("bouton-lancer-essai").disabled = false;
  }
}

function libelleEtatRun(run) {
  if (run.status === "completed") {
    if (run.conclusion === "success") return { texte: "Terminé", classe: "vert" };
    if (run.conclusion === "cancelled") return { texte: "Annulé", classe: "orange" };
    return { texte: "Échoué", classe: "rouge" };
  }
  if (run.status === "in_progress") return { texte: "En cours…", classe: "bleu" };
  return { texte: "En file d'attente…", classe: "orange" };
}

function afficherSuivi(run) {
  document.getElementById("suivi-vide").classList.add("masque");
  document.getElementById("suivi-actif").classList.remove("masque");

  const { texte, classe } = libelleEtatRun(run);
  document.getElementById("suivi-pastille").className = "pastille " + classe;
  document.getElementById("suivi-texte").textContent = texte;

  const debut = new Date(run.run_started_at || run.created_at).getTime();
  const fin = run.status === "completed" ? new Date(run.updated_at).getTime() : Date.now();
  document.getElementById("suivi-duree").textContent = formaterDuree((fin - debut) / 1000);

  const heure = new Date(run.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("suivi-detail").textContent = `Run #${run.run_number} · déclenché à ${heure}`;
  document.getElementById("suivi-lien-github").href = run.html_url;
}

async function rafraichirSuivi() {
  if (!etat.suivi) return;
  try {
    const r = await ghApi(`/repos/${OWNER}/${REPO}/actions/runs/${etat.suivi.id}`);
    const run = await r.json();
    etat.dernierRun = run;
    afficherSuivi(run);
    if (run.status === "completed") {
      arreterSondageSuivi();
      marquerPointResultat(true);
      if (document.getElementById("ecran-resultat").classList.contains("actif")) chargerResultat();
    }
  } catch (e) {
    document.getElementById("suivi-detail").textContent = explicationErreur(e);
  }
}

function arreterSondageSuivi() {
  if (etat.minuteurSondage) { clearInterval(etat.minuteurSondage); etat.minuteurSondage = null; }
  if (etat.minuteurAffichage) { clearInterval(etat.minuteurAffichage); etat.minuteurAffichage = null; }
}

function demarrerSuivi(id) {
  arreterSondageSuivi();
  etat.suivi = { id };
  localStorage.setItem(CLE_DERNIER_RUN, String(id));
  rafraichirSuivi();
  etat.minuteurSondage = setInterval(rafraichirSuivi, 8000);
  etat.minuteurAffichage = setInterval(() => {
    if (etat.dernierRun && etat.dernierRun.status !== "completed") afficherSuivi(etat.dernierRun);
  }, 1000);
}

// --------------------------------------------------------------------------
// Écran RÉSULTAT
// --------------------------------------------------------------------------
async function recupererMeta() {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/meta.json?ref=${BRANCHE_RESULTAT}`);
  const d = await r.json();
  return JSON.parse(decoderBase64Utf8(d.content));
}

async function recupererFichierResultat(nom) {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${nom}?ref=${BRANCHE_RESULTAT}`);
  const d = await r.json();
  return decoderBase64Utf8(d.content);
}

function marquerPointResultat(actif) {
  const onglet = document.getElementById("onglet-resultat");
  let point = onglet.querySelector(".pastille-attente");
  if (actif && !point) {
    point = document.createElement("span");
    point.className = "pastille-attente";
    onglet.appendChild(point);
  } else if (!actif && point) {
    point.remove();
  }
}

async function chargerResultat() {
  const zone = document.getElementById("resultat-contenu");
  zone.innerHTML = '<p class="detail">Chargement…</p>';

  let meta;
  try {
    meta = await recupererMeta();
  } catch (e) {
    if (e.status === 404) {
      zone.innerHTML = '<p class="detail">Aucun résultat pour l’instant — lance une première vidéo.</p>';
    } else {
      afficherAvis(zone, "erreur", explicationErreur(e));
    }
    return;
  }

  const enCours = etat.suivi && etat.dernierRun && etat.dernierRun.status !== "completed";

  zone.innerHTML = `
    ${enCours ? '<div class="avis info" id="avis-en-cours"></div>' : ""}
    <div class="ligne espace">
      <span class="pastille"><span class="point"></span><span id="txt-statut"></span></span>
      <span class="detail" id="txt-date"></span>
    </div>
    <p class="detail" id="txt-theme" style="margin-top:8px"></p>
    <div id="zone-video" style="margin-top:14px"></div>
    <div id="zone-legende" style="margin-top:14px"></div>
    <div id="zone-credits" style="margin-top:10px"></div>`;

  if (enCours) {
    zone.querySelector("#avis-en-cours").textContent =
      "Un run est en cours : ce résultat peut être celui d'un lancement précédent. Il se mettra à jour tout seul.";
  }

  const pictoS = PICTOS_STATUT[meta.statut] || "⚪";
  const pictoV = meta.verdict_qualite ? (PICTOS_VERDICT[meta.verdict_qualite] || "") : "";
  zone.querySelector("#txt-statut").textContent =
    `${pictoS} ${meta.statut || "?"}` + (pictoV ? ` · ${pictoV} ${meta.verdict_qualite}` : "");
  zone.querySelector("#txt-date").textContent = meta.date || "";
  zone.querySelector("#txt-theme").textContent =
    (meta.theme_libelle || meta.theme_slug || "thème inconnu") + (meta.mode === "essai" ? " · essai" : "");

  const zoneVideo = zone.querySelector("#zone-video");
  if (meta.video_presente) {
    zoneVideo.innerHTML = `
      <button class="primaire" id="bouton-telecharger-video">⭳ Télécharger la vidéo</button>
      <div class="barre-progression masque" id="barre-video"><div></div></div>
      <div id="avis-video"></div>`;
    zoneVideo.querySelector("#bouton-telecharger-video")
      .addEventListener("click", () => lancerTelechargementVideo(meta));
  } else {
    zoneVideo.innerHTML = '<p class="detail">Pas de vidéo pour ce résultat.</p>';
  }

  const zoneLegende = zone.querySelector("#zone-legende");
  try {
    const legende = await recupererFichierResultat("legende.txt");
    zoneLegende.innerHTML = `
      <div class="ligne espace"><h2 style="margin:0">Description — à coller telle quelle</h2>
        <button class="petit" id="copier-legende">Copier</button></div>
      <pre class="bloc-copiable"></pre>`;
    zoneLegende.querySelector("pre").textContent = legende;
    zoneLegende.querySelector("#copier-legende")
      .addEventListener("click", () => copierPresse(legende, "copier-legende"));
  } catch { zoneLegende.innerHTML = ""; }

  const zoneCredits = zone.querySelector("#zone-credits");
  try {
    const credits = await recupererFichierResultat("credits.txt");
    zoneCredits.innerHTML = `
      <details class="details-repli">
        <summary>Crédits — en premier commentaire</summary>
        <div class="ligne espace" style="justify-content:flex-end">
          <button class="petit" id="copier-credits">Copier</button></div>
        <pre class="bloc-copiable"></pre>
      </details>`;
    zoneCredits.querySelector("pre").textContent = credits;
    zoneCredits.querySelector("#copier-credits")
      .addEventListener("click", () => copierPresse(credits, "copier-credits"));
  } catch { zoneCredits.innerHTML = ""; }

  marquerPointResultat(false);
}

async function telechargerVideo(nomFichier, onProgress) {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/video.mp4?ref=${BRANCHE_RESULTAT}`);
  const d = await r.json();
  if (!d.download_url) throw new Error("Pas d'URL de téléchargement pour cette vidéo.");

  // AUCUN en-tête personnalisé ici : le jeton est DANS l'URL. Un en-tête
  // Authorization redéclencherait un préflight CORS que ce serveur ne gère pas.
  const reponse = await fetch(d.download_url);
  if (!reponse.ok) throw new Error(`Téléchargement : HTTP ${reponse.status}`);

  let blob;
  if (reponse.body && reponse.body.getReader) {
    const total = Number(reponse.headers.get("Content-Length")) || 0;
    const lecteur = reponse.body.getReader();
    const morceaux = [];
    let recu = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      recu += value.length;
      if (total && onProgress) onProgress(recu / total);
    }
    blob = new Blob(morceaux, { type: "video/mp4" });
  } else {
    blob = await reponse.blob();
  }

  const urlBlob = URL.createObjectURL(blob);
  const lien = document.createElement("a");
  lien.href = urlBlob;
  lien.download = nomFichier;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(urlBlob), 60000);
}

async function lancerTelechargementVideo(meta) {
  const bouton = document.getElementById("bouton-telecharger-video");
  const barre = document.getElementById("barre-video");
  const avis = document.getElementById("avis-video");
  bouton.disabled = true;
  barre.classList.remove("masque");
  avis.innerHTML = "";
  const nomFichier = `${meta.theme_slug || "video"}-${meta.date || "jour"}.mp4`;
  try {
    await telechargerVideo(nomFichier, (f) => {
      barre.querySelector("div").style.width = Math.round(f * 100) + "%";
    });
    afficherAvis(avis, "ok", "Téléchargée.");
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
  } finally {
    bouton.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Écran ÉDITER — formulaire
// --------------------------------------------------------------------------
async function chargerFichierEditeur(nom) {
  if (editeur.fichiers[nom]) return editeur.fichiers[nom];
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${nom}?ref=main`);
  const d = await r.json();
  editeur.fichiers[nom] = { texte: decoderBase64Utf8(d.content), sha: d.sha };
  return editeur.fichiers[nom];
}

function _idChamp(volet, cle) { return `champ-${volet}-${cle.replace(/\./g, "_")}`; }

function construireChamp(volet, champ, valeur) {
  const bloc = document.createElement("div");
  const id = _idChamp(volet, champ.cle);

  // Une clé introuvable n'est PAS présentée comme vide : l'écrire ensuite
  // écraserait autre chose ou échouerait. On la montre désactivée, en clair.
  if (valeur === null || valeur === undefined) {
    bloc.className = "champ";
    bloc.innerHTML = `<label class="titre"></label><p class="aide"></p>`;
    bloc.querySelector(".titre").textContent = champ.libelle;
    bloc.querySelector(".aide").textContent =
      `Introuvable dans ${SCHEMA[volet].fichier} — à modifier en mode Avancé.`;
    return bloc;
  }

  if (champ.type === "bool") {
    bloc.className = "champ interrupteur";
    bloc.innerHTML = `
      <label class="bascule">
        <input type="checkbox" id="${id}"><span class="piste"></span>
      </label>
      <div class="contenu"><label class="titre" for="${id}"></label><p class="aide"></p></div>`;
    bloc.querySelector(".titre").textContent = champ.libelle;
    bloc.querySelector(".aide").textContent = champ.aide;
    bloc.querySelector("input").checked = String(valeur) === "true";
    return bloc;
  }

  bloc.className = "champ";
  bloc.innerHTML = `<label class="titre" for="${id}"></label><p class="aide"></p>`;
  bloc.querySelector(".titre").textContent = champ.libelle;
  bloc.querySelector(".aide").textContent = champ.aide;

  let controle;
  if (champ.type === "choix") {
    controle = document.createElement("select");
    champ.options.forEach(([val, libelle]) => {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = libelle;
      controle.appendChild(o);
    });
    controle.value = String(valeur);
  } else if (champ.type === "nombre") {
    controle = document.createElement("input");
    controle.type = "number";
    controle.value = String(valeur);
  } else if (champ.type === "liste-inline" || champ.type === "liste-tirets") {
    controle = document.createElement("textarea");
    controle.rows = Math.min(10, Math.max(3, valeur.length));
    controle.value = valeur.join("\n");
    bloc.querySelector(".aide").textContent = champ.aide + " — un par ligne.";
  } else if (champ.type === "bloc") {
    controle = document.createElement("textarea");
    controle.rows = 7;
    controle.value = valeur;
  } else {
    controle = document.createElement("input");
    controle.type = "text";
    controle.value = String(valeur);
  }
  controle.id = id;
  bloc.appendChild(controle);
  return bloc;
}

function valeurDuChamp(volet, champ) {
  const el = document.getElementById(_idChamp(volet, champ.cle));
  if (!el) return null;
  if (champ.type === "bool") return el.checked;
  if (champ.type === "nombre") return Number(el.value);
  if (champ.type === "liste-inline" || champ.type === "liste-tirets") {
    return el.value.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  }
  return el.value;
}

function memeValeur(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

async function afficherFormulaire(volet) {
  editeur.voletActuel = volet;
  const zone = document.getElementById("champs");
  const zoneEtat = document.getElementById("editeur-etat");
  zone.innerHTML = "";
  document.getElementById("editeur-avis").innerHTML = "";
  zoneEtat.textContent = "Chargement…";

  const def = SCHEMA[volet];
  try {
    const fichier = await chargerFichierEditeur(def.fichier);
    def.champs.forEach((champ) => {
      const valeur = lireChamp(fichier.texte, champ);
      editeur.origine[`${def.fichier}|${champ.cle}`] = valeur;
      zone.appendChild(construireChamp(volet, champ, valeur));
    });
    zoneEtat.textContent = `${def.fichier} — les commentaires du fichier sont préservés à l'enregistrement.`;
    zone.addEventListener("input", majResumeModifications);
    zone.addEventListener("change", majResumeModifications);
    majResumeModifications();
  } catch (e) {
    zoneEtat.textContent = explicationErreur(e);
  }
}

function modificationsEnCours() {
  const def = SCHEMA[editeur.voletActuel];
  if (!def) return [];
  return def.champs.filter((champ) => {
    const origine = editeur.origine[`${def.fichier}|${champ.cle}`];
    if (origine === null || origine === undefined) return false;
    return !memeValeur(valeurDuChamp(editeur.voletActuel, champ), origine);
  });
}

function majResumeModifications() {
  const modifs = modificationsEnCours();
  const resume = document.getElementById("editeur-resume");
  const bouton = document.getElementById("bouton-enregistrer");
  if (modifs.length === 0) {
    resume.textContent = "Aucune modification.";
    bouton.disabled = true;
  } else {
    resume.textContent = `${modifs.length} modification${modifs.length > 1 ? "s" : ""} : `
      + modifs.map((c) => c.libelle).join(", ");
    bouton.disabled = false;
  }
}

async function enregistrerFormulaire() {
  const def = SCHEMA[editeur.voletActuel];
  const modifs = modificationsEnCours();
  const zoneAvis = document.getElementById("editeur-avis");
  const bouton = document.getElementById("bouton-enregistrer");
  if (modifs.length === 0) return;

  bouton.disabled = true;
  afficherAvis(zoneAvis, "info", "Enregistrement…");
  try {
    const fichier = editeur.fichiers[def.fichier];
    let texte = fichier.texte;
    modifs.forEach((champ) => {
      texte = ecrireChamp(texte, champ, valeurDuChamp(editeur.voletActuel, champ));
    });

    const maintenant = new Date().toISOString().slice(0, 16).replace("T", " ");
    const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${def.fichier}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `${def.fichier} depuis le panneau — ${modifs.map((c) => c.libelle).join(", ")} (${maintenant})`,
        content: encoderBase64Utf8(texte),
        sha: fichier.sha,
        branch: "main",
      }),
    });
    const d = await r.json();
    editeur.fichiers[def.fichier] = { texte, sha: d.content.sha };
    modifs.forEach((champ) => {
      editeur.origine[`${def.fichier}|${champ.cle}`] = valeurDuChamp(editeur.voletActuel, champ);
    });
    majResumeModifications();
    afficherAvis(zoneAvis, "ok", "Enregistré. Prise en compte au prochain lancement.");
  } catch (e) {
    if (e.status === 409) {
      delete editeur.fichiers[def.fichier];
      afficherAvis(zoneAvis, "erreur", "Le fichier a changé entre-temps sur GitHub — rechargement.");
      await afficherFormulaire(editeur.voletActuel);
    } else {
      afficherAvis(zoneAvis, "erreur", explicationErreur(e));
    }
  } finally {
    majResumeModifications();
  }
}

// --------------------------------------------------------------------------
// Écran ÉDITER — mode avancé (fichier brut)
// --------------------------------------------------------------------------
async function chargerBrut(nom) {
  editeur.fichierBrut = nom;
  document.querySelectorAll("[data-brut]").forEach((b) => b.classList.toggle("actif", b.dataset.brut === nom));
  const zoneEtat = document.getElementById("brut-etat");
  const zoneTexte = document.getElementById("brut-texte");
  document.getElementById("brut-avis").innerHTML = "";
  zoneTexte.disabled = true;
  zoneEtat.textContent = "Chargement…";
  try {
    delete editeur.fichiers[nom];           // toujours la version fraîche ici
    const fichier = await chargerFichierEditeur(nom);
    zoneTexte.value = fichier.texte;
    zoneTexte.disabled = false;
    zoneEtat.textContent = `${nom} — fichier complet.`;
  } catch (e) {
    zoneEtat.textContent = explicationErreur(e);
  }
}

async function enregistrerBrut() {
  const nom = editeur.fichierBrut;
  const texte = document.getElementById("brut-texte").value;
  const zoneAvis = document.getElementById("brut-avis");
  const bouton = document.getElementById("bouton-enregistrer-brut");
  bouton.disabled = true;
  afficherAvis(zoneAvis, "info", "Enregistrement…");
  try {
    const fichier = editeur.fichiers[nom];
    const maintenant = new Date().toISOString().slice(0, 16).replace("T", " ");
    const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${nom}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `${nom} depuis le panneau (mode avancé) — ${maintenant}`,
        content: encoderBase64Utf8(texte),
        sha: fichier.sha,
        branch: "main",
      }),
    });
    const d = await r.json();
    editeur.fichiers[nom] = { texte, sha: d.content.sha };
    afficherAvis(zoneAvis, "ok", "Enregistré.");
  } catch (e) {
    if (e.status === 409) {
      afficherAvis(zoneAvis, "erreur", "Le fichier a changé entre-temps — rechargement.");
      await chargerBrut(nom);
    } else {
      afficherAvis(zoneAvis, "erreur", explicationErreur(e));
    }
  } finally {
    bouton.disabled = false;
  }
}

function choisirVolet(volet) {
  document.querySelectorAll("[data-volet]").forEach((b) => b.classList.toggle("actif", b.dataset.volet === volet));
  const avance = volet === "avance";
  document.getElementById("volet-formulaire").classList.toggle("masque", avance);
  document.getElementById("volet-avance").classList.toggle("masque", !avance);
  if (avance) chargerBrut(editeur.fichierBrut);
  else afficherFormulaire(volet);
}

// --------------------------------------------------------------------------
// Thème jour / nuit
// --------------------------------------------------------------------------
function themeChoisi() { return localStorage.getItem(CLE_THEME) || "auto"; }

function appliquerTheme(choix) {
  if (choix === "auto") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(CLE_THEME);
  } else {
    document.documentElement.dataset.theme = choix;
    localStorage.setItem(CLE_THEME, choix);
  }
  const actuel = themeChoisi();
  const picto = { auto: "🌗", clair: "☀️", sombre: "🌙" }[actuel];
  document.getElementById("bouton-theme").textContent = picto;
  const etiquette = { auto: "Automatique — suit le réglage du téléphone", clair: "Clair", sombre: "Sombre" }[actuel];
  const zone = document.getElementById("theme-actuel");
  if (zone) zone.textContent = etiquette;
  document.querySelectorAll("[data-theme-choix]").forEach((b) => {
    b.classList.toggle("actif", b.dataset.themeChoix === actuel);
  });
}

function basculerTheme() {
  const suite = { auto: "clair", clair: "sombre", sombre: "auto" };
  appliquerTheme(suite[themeChoisi()]);
}

// --------------------------------------------------------------------------
// Écran RÉGLAGES
// --------------------------------------------------------------------------
function enregistrerPat() {
  const champ = document.getElementById("champ-pat");
  const valeur = champ.value.trim();
  if (!valeur) return;
  localStorage.setItem(CLE_PAT, valeur);
  champ.value = "";
  afficherAvis("reglages-avis", "ok", "Jeton enregistré sur cet appareil.");
}

async function testerPat() {
  const zone = document.getElementById("reglages-avis");
  zone.innerHTML = "";
  try {
    const r = await ghApi(`/repos/${OWNER}/${REPO}`);
    const d = await r.json();
    afficherAvis(zone, "ok", `Connecté : ${d.full_name} (${d.private ? "privé" : "public"}).`);
  } catch (e) {
    afficherAvis(zone, "erreur", explicationErreur(e));
  }
}

function deconnecter() {
  if (!confirm("Effacer le jeton de cet appareil ?")) return;
  localStorage.removeItem(CLE_PAT);
  afficherAvis("reglages-avis", "info", "Jeton effacé.");
}

// --------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------
function changerEcran(nom) {
  document.querySelectorAll(".ecran").forEach((s) => s.classList.toggle("actif", s.id === "ecran-" + nom));
  document.querySelectorAll("nav.bas button[data-ecran]").forEach((b) => b.classList.toggle("actif", b.dataset.ecran === nom));
  document.getElementById("fil-ariane").textContent = LIBELLES_ECRAN[nom] || "";
  if (nom === "resultat") chargerResultat();
  if (nom === "editer") choisirVolet(editeur.voletActuel);
}

// --------------------------------------------------------------------------
// Démarrage
// --------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("nav.bas button[data-ecran]").forEach((b) => {
    b.addEventListener("click", () => changerEcran(b.dataset.ecran));
  });
  document.getElementById("bouton-reglages").addEventListener("click", () => changerEcran("reglages"));
  document.getElementById("bouton-theme").addEventListener("click", basculerTheme);
  document.querySelectorAll("[data-theme-choix]").forEach((b) => {
    b.addEventListener("click", () => appliquerTheme(b.dataset.themeChoix));
  });

  document.getElementById("bouton-lancer-production").addEventListener("click", () => lancerVideo("production"));
  document.getElementById("bouton-lancer-essai").addEventListener("click", () => lancerVideo("essai"));
  document.getElementById("bouton-rafraichir-resultat").addEventListener("click", chargerResultat);

  document.querySelectorAll("[data-volet]").forEach((b) => {
    b.addEventListener("click", () => choisirVolet(b.dataset.volet));
  });
  document.querySelectorAll("[data-brut]").forEach((b) => {
    b.addEventListener("click", () => chargerBrut(b.dataset.brut));
  });
  document.getElementById("bouton-enregistrer").addEventListener("click", enregistrerFormulaire);
  document.getElementById("bouton-enregistrer-brut").addEventListener("click", enregistrerBrut);

  document.getElementById("bouton-enregistrer-pat").addEventListener("click", enregistrerPat);
  document.getElementById("bouton-tester-pat").addEventListener("click", testerPat);
  document.getElementById("bouton-deconnecter").addEventListener("click", deconnecter);

  appliquerTheme(themeChoisi());

  if (!obtenirPat()) {
    changerEcran("reglages");
    afficherAvis("reglages-avis", "info", "Colle ton jeton ci-dessus pour commencer.");
  }

  const idSauvegarde = localStorage.getItem(CLE_DERNIER_RUN);
  if (idSauvegarde && obtenirPat()) demarrerSuivi(Number(idSauvegarde));
});
