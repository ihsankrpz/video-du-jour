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
const WORKFLOW_MAINTENANCE = "maintenance.yml";
const BRANCHE_RESULTAT = "dernier-resultat";
// Publiée par le runner : catalogue de la banque distante (URLs signées, donc
// consultable sans aucune clé) et historique des vidéos encore téléchargeables.
const BRANCHE_DONNEES = "donnees-panneau";
// Sas de transit pour un média ajouté depuis le téléphone. Le runner le vide
// une fois le fichier chez Supabase : rien n'y séjourne.
const BRANCHE_DEPOT = "depot-banque";
// Au-delà, l'API Contents refuse le dépôt. La limite documentée est de 100 Mo,
// mais le corps JSON transporte du base64 — un tiers de plus que le fichier —,
// donc on s'arrête franchement en dessous plutôt que de faire téléverser
// quarante mégaoctets pour un refus.
const LIMITE_DEPOT_OCTETS = 40 * 1024 * 1024;
const API_BASE = "https://api.github.com";

const CLE_PAT = "vdj_pat";
const CLE_DERNIER_RUN = "vdj_dernier_run_id";
const CLE_THEME = "vdj_theme";

const LIBELLES_ECRAN = {
  lancer: "Panneau de contrôle",
  resultat: "Résultats",
  banque: "Banque distante",
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
      { cle: "source_visuels", type: "choix", libelle: "Source des images",
        options: [
          ["auto", "Auto — Pexels et Pixabay, la banque en dernier recours"],
          ["banque", "Banque — seulement ce qu'on possède déjà, aucun appel"],
        ],
        aide: "« banque » ne consomme aucun quota et va plus vite, mais ne montre que des plans déjà vus : la banque ne contient que ce qu'on y a mis." },
      { cle: "secours_auto", type: "bool", libelle: "Remplir la banque de secours",
        aide: "Éteint, un thème neuf échouera au lieu de télécharger ses clips tout seul." },
      { cle: "supabase.actif", type: "bool", libelle: "Banque distante Supabase",
        aide: "Éteinte, la chaîne n'utilise que la banque locale, comme avant elle. Rien ne casse : les clips cessent simplement d'être partagés entre machines." },
      { cle: "supabase.televerser_auto", type: "bool", libelle: "Partager les clips téléchargés",
        aide: "Chaque clip pris chez Pexels ou Pixabay part aussi vers Supabase, et resservira aux vidéos suivantes sans être retéléchargé." },
      { cle: "supabase.taille_max_mo", type: "nombre", libelle: "Plafond par fichier (Mo)",
        aide: "Limite du palier Supabase, pas un réglage de qualité. Au-dessus, le clip est écarté du PARTAGE, jamais de la vidéo. Le palier gratuit refuse au-delà de 50." },
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
  if (nom === "banque") chargerBanque();
  if (nom === "reglages") chargerEtatStockage();
}

// --------------------------------------------------------------------------
// Données publiées par le runner (branche `donnees-panneau`)
// --------------------------------------------------------------------------
// On passe par `download_url` et non par le champ `content` : au-delà d'un Mo,
// l'API Contents renvoie `content: ""` avec `encoding: "none"`, et le catalogue
// est fait pour grossir. `download_url` porte un jeton signé DANS l'URL, donc
// fetch() l'appelle sans aucun en-tête — sans préflight, la seule chose qui
// casse sur ce chemin.
async function lireJsonBranche(branche, nom) {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${nom}?ref=${branche}`);
  const d = await r.json();
  if (!d.download_url) throw new Error(`Pas d'URL de téléchargement pour ${nom}.`);
  const contenu = await fetch(d.download_url);
  if (!contenu.ok) throw new Error(`${nom} : HTTP ${contenu.status}`);
  return contenu.json();
}

function formaterOctets(octets) {
  if (!octets) return "—";
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

// --------------------------------------------------------------------------
// Workflow « Maintenance » : toute MODIFICATION de la banque passe par lui
// --------------------------------------------------------------------------
// Le panneau ne détient aucune clé Supabase, et c'est délibéré : la seule dont
// nous disposions contourne toutes les règles de sécurité du projet. Le runner,
// lui, l'a déjà par les secrets du dépôt. Le panneau demande, le runner agit.
async function dispatcherMaintenance(entrees) {
  const r0 = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_MAINTENANCE}/runs?per_page=1`);
  const d0 = await r0.json();
  const avant = (d0.workflow_runs[0] && d0.workflow_runs[0].id) || 0;

  await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_MAINTENANCE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: entrees }),
  });
  // Même piège que pour la production : `dispatches` répond 204 sans identifiant.
  // On guette un run dont l'id dépasse celui relevé juste avant.
  for (let essai = 0; essai < 20; essai++) {
    await attendre(3000);
    const r = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_MAINTENANCE}/runs?per_page=5`);
    const d = await r.json();
    const nouveau = d.workflow_runs.find((x) => x.id > avant);
    if (nouveau) return nouveau.id;
  }
  throw new Error("Le run de maintenance n'est pas apparu — vérifie l'onglet Actions.");
}

async function attendreRun(id, surAvancement) {
  for (let essai = 0; essai < 100; essai++) {
    const r = await ghApi(`/repos/${OWNER}/${REPO}/actions/runs/${id}`);
    const run = await r.json();
    if (run.status === "completed") return run.conclusion;
    if (surAvancement) surAvancement(run.status);
    await attendre(4000);
  }
  throw new Error("Le run de maintenance dure anormalement longtemps.");
}

// --------------------------------------------------------------------------
// Écran BANQUE
// --------------------------------------------------------------------------
const banque = { catalogue: null, bacActuel: "videos" };

function choisirBac(bac) {
  banque.bacActuel = bac;
  document.querySelectorAll("[data-bac]").forEach((b) => b.classList.toggle("actif", b.dataset.bac === bac));
  afficherBac();
}

function construireFicheMedia(entree, bac) {
  const carte = document.createElement("div");
  carte.className = "carte fiche-media";

  // L'aperçu n'est proposé QUE si le runner a pu signer l'URL. Une balise
  // <video> sans source afficherait un cadre noir muet, qu'on prendrait pour
  // un média corrompu plutôt que pour une signature expirée.
  if (entree.url && bac === "videos") {
    const video = document.createElement("video");
    video.src = entree.url;
    video.controls = true;
    video.preload = "none";
    video.playsInline = true;
    carte.appendChild(video);
  } else if (entree.url && bac === "images") {
    const img = document.createElement("img");
    img.src = entree.url;
    img.alt = entree.titre || entree.fichier;
    img.loading = "lazy";
    carte.appendChild(img);
  } else if (entree.url && bac === "musique") {
    const audio = document.createElement("audio");
    audio.src = entree.url;
    audio.controls = true;
    audio.preload = "none";
    carte.appendChild(audio);
  }

  const titre = document.createElement("p");
  titre.className = "fiche-titre";
  titre.textContent = entree.titre || entree.fichier;
  carte.appendChild(titre);

  const meta = document.createElement("p");
  meta.className = "detail";
  const morceaux = [entree.theme, entree.auteur, entree.type_licence, formaterOctets(entree.octets)]
    .filter((x) => x);
  meta.textContent = morceaux.join(" · ");
  carte.appendChild(meta);

  if (!entree.indexe) {
    const alerte = document.createElement("p");
    alerte.className = "detail alerte-inline";
    alerte.textContent = "Sans entrée d'index : ce média occupe de la place mais "
      + "ne sera jamais utilisé par une production.";
    carte.appendChild(alerte);
  }

  if ((entree.mots_cles || []).length) {
    const mots = document.createElement("p");
    mots.className = "detail";
    mots.textContent = "Mots-clés : " + entree.mots_cles.join(", ");
    carte.appendChild(mots);
  }

  const barre = document.createElement("div");
  barre.className = "ligne";
  const bouton = document.createElement("button");
  bouton.className = "discret";
  bouton.textContent = "Supprimer";
  bouton.addEventListener("click", () => supprimerMedia(bac, entree, bouton));
  barre.appendChild(bouton);
  if (entree.source) {
    const lien = document.createElement("a");
    lien.href = entree.source;
    lien.target = "_blank";
    lien.rel = "noopener";
    lien.className = "detail";
    lien.textContent = "Source ↗";
    barre.appendChild(lien);
  }
  carte.appendChild(barre);
  return carte;
}

function afficherBac() {
  const liste = document.getElementById("banque-liste");
  const etat = document.getElementById("banque-etat");
  liste.innerHTML = "";
  if (!banque.catalogue) { etat.textContent = "Catalogue non chargé."; return; }
  if (!banque.catalogue.actif) {
    etat.textContent = "Banque distante inactive : active-la dans Éditer → Réglages, "
      + "puis relance une production ou « Recalculer le catalogue ».";
    return;
  }
  const bac = banque.catalogue.bacs[banque.bacActuel];
  if (!bac) { etat.textContent = "Ce bac n'apparaît pas au catalogue."; return; }

  const genere = (banque.catalogue.genere_le || "").replace("T", " ").slice(0, 16);
  etat.textContent = `${bac.objets} média(s), ${formaterOctets(bac.octets)} — catalogue du ${genere}.`
    + (bac.entrees_orphelines.length
      ? ` ${bac.entrees_orphelines.length} entrée(s) d'index sans fichier.`
      : "");
  document.getElementById("banque-titre").textContent = `Banque — ${bac.nom}`;

  if (!bac.entrees.length) {
    liste.innerHTML = '<div class="carte"><p class="detail">Ce bac est vide.</p></div>';
    return;
  }
  bac.entrees.forEach((e) => liste.appendChild(construireFicheMedia(e, banque.bacActuel)));
}

async function chargerBanque() {
  const etat = document.getElementById("banque-etat");
  etat.textContent = "Chargement…";
  document.getElementById("banque-liste").innerHTML = "";
  try {
    banque.catalogue = await lireJsonBranche(BRANCHE_DONNEES, "catalogue.json");
    afficherBac();
  } catch (e) {
    banque.catalogue = null;
    etat.textContent = e.status === 404
      ? "Aucun catalogue publié pour l'instant. Lance « Recalculer le catalogue »."
      : explicationErreur(e);
  }
}

async function supprimerMedia(bac, entree, bouton) {
  const nom = entree.titre || entree.fichier;
  if (!window.confirm(`Supprimer « ${nom} » de la banque ?\n\nLe fichier et son entrée `
      + `d'index partent ensemble, définitivement.`)) return;
  bouton.disabled = true;
  const avis = document.getElementById("banque-avis");
  afficherAvis(avis, "info", "Demande envoyée au runner…");
  try {
    const id = await dispatcherMaintenance({
      action: "supprimer", bac, chemin: entree.chemin,
    });
    afficherAvis(avis, "info", "Suppression en cours sur le runner…");
    const verdict = await attendreRun(id);
    if (verdict !== "success") throw new Error(`Le run s'est terminé en « ${verdict} ».`);
    afficherAvis(avis, "ok", `« ${nom} » supprimé.`);
    await chargerBanque();
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
    bouton.disabled = false;
  }
}

async function recalculerCatalogue() {
  const avis = document.getElementById("banque-avis");
  afficherAvis(avis, "info", "Recalcul demandé au runner…");
  try {
    const id = await dispatcherMaintenance({ action: "catalogue" });
    const verdict = await attendreRun(id);
    if (verdict !== "success") throw new Error(`Le run s'est terminé en « ${verdict} ».`);
    afficherAvis(avis, "ok", "Catalogue republié.");
    await chargerBanque();
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
  }
}

// --------------------------------------------------------------------------
// Ajout d'un média
// --------------------------------------------------------------------------
// Un `workflow_dispatch` ne transporte que des chaînes, plafonnées : un média
// en base64 les ferait éclater. Le fichier transite donc par une branche-sas du
// dépôt, que le runner vide une fois le transfert fait chez Supabase.
function lireFichierBase64(fichier) {
  return new Promise((resoudre, rejeter) => {
    const lecteur = new FileReader();
    lecteur.onerror = () => rejeter(new Error("Lecture du fichier impossible."));
    lecteur.onload = () => {
      // `result` vaut « data:<type>;base64,<charge> » : on ne garde que la charge.
      const brut = String(lecteur.result);
      resoudre(brut.slice(brut.indexOf(",") + 1));
    };
    lecteur.readAsDataURL(fichier);
  });
}

function nomSur(nom) {
  const base = nom.split(/[\\/]/).pop().trim();
  const propre = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return propre || "media";
}

async function envoyerAjout() {
  const avis = document.getElementById("ajout-avis");
  const champFichier = document.getElementById("ajout-fichier");
  const fichier = champFichier.files && champFichier.files[0];
  const valeur = (id) => document.getElementById(id).value.trim();

  if (!fichier) { afficherAvis(avis, "erreur", "Choisis d'abord un fichier."); return; }
  const licence = valeur("ajout-licence");
  const auteur = valeur("ajout-auteur");
  const source = valeur("ajout-source");
  if (!licence || !auteur || !source) {
    // Le runner refuserait de toute façon : mieux vaut le dire ici que de
    // faire attendre quarante secondes pour un refus prévisible.
    afficherAvis(avis, "erreur", "Auteur, source et licence sont obligatoires — "
      + "un média sans licence complète ne serait jamais utilisé par une production.");
    return;
  }
  if (fichier.size > LIMITE_DEPOT_OCTETS) {
    afficherAvis(avis, "erreur", `Fichier de ${formaterOctets(fichier.size)} : au-dessus `
      + `de la limite de ${formaterOctets(LIMITE_DEPOT_OCTETS)} que l'API GitHub accepte `
      + `pour ce transit. Passe par une production, ou allège le média.`);
    return;
  }

  const bouton = document.getElementById("bouton-envoyer-ajout");
  bouton.disabled = true;
  try {
    afficherAvis(avis, "info", "Envoi du fichier…");
    const nom = nomSur(fichier.name);
    const base64 = await lireFichierBase64(fichier);

    // Le sas peut déjà contenir un fichier de ce nom : l'API Contents exige
    // alors le `sha` du précédent, sans quoi elle rend 422.
    let sha;
    try {
      const existant = await ghApi(
        `/repos/${OWNER}/${REPO}/contents/depot/${nom}?ref=${BRANCHE_DEPOT}`);
      sha = (await existant.json()).sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    await ghApi(`/repos/${OWNER}/${REPO}/contents/depot/${nom}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Sas : ${nom}`, content: base64, branch: BRANCHE_DEPOT,
        ...(sha ? { sha } : {}),
      }),
    });

    afficherAvis(avis, "info", "Fichier déposé. Le runner le transfère vers Supabase…");
    const id = await dispatcherMaintenance({
      action: "ajouter", bac: banque.bacActuel, chemin: nom,
      theme: valeur("ajout-theme") || "divers",
      titre: valeur("ajout-titre"), auteur, source, licence,
      mots_cles: valeur("ajout-mots"),
    });
    const verdict = await attendreRun(id);
    if (verdict !== "success") throw new Error(`Le run s'est terminé en « ${verdict} ».`);

    afficherAvis(avis, "ok", `« ${nom} » ajouté à la banque.`);
    ["ajout-titre", "ajout-auteur", "ajout-source", "ajout-licence", "ajout-mots"]
      .forEach((id2) => { document.getElementById(id2).value = ""; });
    champFichier.value = "";
    document.getElementById("carte-ajout").classList.add("masque");
    await chargerBanque();
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
  } finally {
    bouton.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Volet ANCIENS RÉSULTATS
// --------------------------------------------------------------------------
function construireFicheResultat(resultat) {
  const carte = document.createElement("div");
  carte.className = "carte";

  const entete = document.createElement("div");
  entete.className = "ligne espace";
  const titre = document.createElement("p");
  titre.className = "fiche-titre";
  titre.textContent = resultat.titre || resultat.etiquette;
  entete.appendChild(titre);
  if (resultat.essai) {
    const marque = document.createElement("span");
    marque.className = "etiquette orange";
    marque.textContent = "essai";
    entete.appendChild(marque);
  }
  carte.appendChild(entete);

  const meta = document.createElement("p");
  meta.className = "detail";
  meta.textContent = [(resultat.publie_le || "").slice(0, 10), formaterOctets(resultat.octets)]
    .filter((x) => x).join(" · ");
  carte.appendChild(meta);

  if (resultat.miniature) {
    const img = document.createElement("img");
    img.className = "miniature";
    img.loading = "lazy";
    img.alt = "";
    // La miniature vit sur la branche de données : même chemin signé que le
    // reste, donc récupérable sans en-tête.
    lireUrlBranche(BRANCHE_DONNEES, resultat.miniature)
      .then((u) => { img.src = u; })
      .catch(() => { img.remove(); });
    carte.appendChild(img);
  }

  const textes = [["Légende", resultat.legende], ["Hashtags", resultat.hashtags],
                  ["Crédits", resultat.credits]];
  textes.forEach(([etiquette, contenu], rang) => {
    if (!contenu) return;
    const bloc = document.createElement("details");
    bloc.className = "details-repli";
    const resume = document.createElement("summary");
    resume.textContent = etiquette;
    bloc.appendChild(resume);
    const zone = document.createElement("pre");
    zone.className = "texte-copiable";
    zone.textContent = contenu;
    bloc.appendChild(zone);
    const copier = document.createElement("button");
    copier.className = "petit";
    copier.id = `copier-${resultat.etiquette}-${rang}`;
    copier.textContent = "Copier";
    copier.addEventListener("click", () => copierPresse(contenu, copier.id));
    bloc.appendChild(copier);
    carte.appendChild(bloc);
  });

  if (resultat.url_video) {
    // NAVIGATION, pas fetch() : l'asset d'une Release redirige vers un stockage
    // Azure qui ne renvoie aucun en-tête CORS — une récupération par script
    // échouerait sans indice. Un lien ouvre le téléchargement natif du
    // téléphone, à condition d'être connecté à GitHub dans ce navigateur.
    const lien = document.createElement("a");
    lien.className = "bouton-lien";
    lien.href = resultat.url_video;
    lien.target = "_blank";
    lien.rel = "noopener";
    lien.textContent = "Télécharger la vidéo ↗";
    carte.appendChild(lien);
  }
  return carte;
}

async function lireUrlBranche(branche, nom) {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${nom}?ref=${branche}`);
  const d = await r.json();
  if (!d.download_url) throw new Error(`Pas d'URL pour ${nom}.`);
  return d.download_url;
}

async function chargerAnciens() {
  const etat = document.getElementById("anciens-etat");
  const liste = document.getElementById("anciens-liste");
  etat.textContent = "Chargement…";
  liste.innerHTML = "";
  try {
    const historique = await lireJsonBranche(BRANCHE_DONNEES, "historique.json");
    const resultats = historique.resultats || [];
    if (!resultats.length) {
      etat.textContent = "Aucune vidéo gardée pour l'instant.";
      return;
    }
    const poids = resultats.reduce((t, r) => t + (r.octets || 0), 0);
    etat.textContent = `${resultats.length} vidéo(s) encore téléchargeable(s), `
      + `${formaterOctets(poids)} au total sur GitHub.`;
    resultats.forEach((r) => liste.appendChild(construireFicheResultat(r)));
  } catch (e) {
    etat.textContent = e.status === 404
      ? "Aucun historique publié pour l'instant : il le sera à la prochaine production."
      : explicationErreur(e);
  }
}

function choisirVoletResultat(volet) {
  document.querySelectorAll("[data-volet-resultat]").forEach((b) =>
    b.classList.toggle("actif", b.dataset.voletResultat === volet));
  document.getElementById("volet-resultat-dernier").classList.toggle("masque", volet !== "dernier");
  document.getElementById("volet-resultat-anciens").classList.toggle("masque", volet !== "anciens");
  if (volet === "anciens") chargerAnciens();
  else chargerResultat();
}

// --------------------------------------------------------------------------
// Purge du stockage GitHub
// --------------------------------------------------------------------------
async function chargerEtatStockage() {
  const etat = document.getElementById("stockage-etat");
  try {
    const historique = await lireJsonBranche(BRANCHE_DONNEES, "historique.json");
    const resultats = historique.resultats || [];
    const poids = resultats.reduce((t, r) => t + (r.octets || 0), 0);
    etat.textContent = `${resultats.length} Release(s) conservée(s), `
      + `${formaterOctets(poids)} de vidéos. Les artefacts s'ajoutent à ce total.`;
  } catch {
    etat.textContent = "État inconnu tant qu'aucune production n'a publié l'historique.";
  }
}

async function lancerPurge() {
  const avis = document.getElementById("purge-avis");
  const bouton = document.getElementById("bouton-purger");
  if (!window.confirm("Purger le stockage GitHub ?\n\nLes Releases les plus anciennes "
      + "et leurs vidéos seront supprimées définitivement, ainsi que les artefacts "
      + "trop vieux. Les plus récentes sont gardées.")) return;
  bouton.disabled = true;
  afficherAvis(avis, "info", "Purge demandée au runner…");
  try {
    const id = await dispatcherMaintenance({ action: "purge" });
    const verdict = await attendreRun(id);
    if (verdict !== "success") throw new Error(`Le run s'est terminé en « ${verdict} ».`);
    afficherAvis(avis, "ok", "Purge terminée — le détail est dans le compte rendu du run.");
    await chargerEtatStockage();
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
  } finally {
    bouton.disabled = false;
  }
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

  document.querySelectorAll("[data-volet-resultat]").forEach((b) => {
    b.addEventListener("click", () => choisirVoletResultat(b.dataset.voletResultat));
  });
  document.getElementById("bouton-rafraichir-anciens").addEventListener("click", chargerAnciens);

  document.querySelectorAll("[data-bac]").forEach((b) => {
    b.addEventListener("click", () => choisirBac(b.dataset.bac));
  });
  document.getElementById("bouton-rafraichir-banque").addEventListener("click", chargerBanque);
  document.getElementById("bouton-recatalogue").addEventListener("click", recalculerCatalogue);
  document.getElementById("bouton-ouvrir-ajout").addEventListener("click", () => {
    document.getElementById("carte-ajout").classList.remove("masque");
  });
  document.getElementById("bouton-annuler-ajout").addEventListener("click", () => {
    document.getElementById("carte-ajout").classList.add("masque");
  });
  document.getElementById("bouton-envoyer-ajout").addEventListener("click", envoyerAjout);
  document.getElementById("bouton-purger").addEventListener("click", lancerPurge);

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
