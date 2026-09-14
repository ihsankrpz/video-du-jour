/*
 * Panneau de contrôle « Vidéo du jour ».
 *
 * Page statique, sans dépendance externe. Elle ne contient AUCUN secret : le
 * jeton d'accès (PAT) est collé une fois par l'utilisateur et reste dans le
 * stockage local de SON navigateur — jamais envoyé ailleurs qu'à l'API GitHub,
 * en HTTPS, depuis son propre appareil.
 *
 * === Le piège du téléchargement de la vidéo, et pourquoi ce code l'évite ===
 * L'asset d'une Release GitHub se télécharge via une redirection vers Azure
 * Blob Storage, et cette réponse finale NE RENVOIE AUCUN EN-TÊTE CORS —
 * vérifié avant d'écrire ce fichier. Un fetch() depuis cette page échouerait
 * donc systématiquement sur ce chemin, avec une erreur "Failed to fetch" sans
 * aucun indice de la cause réelle.
 *
 * Le mécanisme qui fonctionne : un fichier SUIVI PAR GIT expose, via l'API
 * Contents, un `download_url` qui porte un jeton signé DANS L'URL elle-même.
 * fetch() peut alors appeler cette URL SANS AUCUN EN-TÊTE PERSONNALISÉ — donc
 * sans déclencher de préflight CORS, la seule chose qui casse sur ce chemin —
 * et le serveur répond avec Access-Control-Allow-Origin: *. C'est pourquoi le
 * dépôt piloté pousse son résultat sur une branche dédiée (`dernier-resultat`)
 * plutôt que de s'appuyer sur la Release pour ce que lit CETTE page.
 */

const OWNER = "ihsankrpz";
const REPO = "Tiktok_Auto";
const WORKFLOW_FILE = "video.yml";
const BRANCHE_RESULTAT = "dernier-resultat";
const API_BASE = "https://api.github.com";

const CLE_PAT = "vdj_pat";
const CLE_DERNIER_RUN = "vdj_dernier_run_id";

const LIBELLES_ECRAN = {
  lancer: "Panneau de contrôle",
  resultat: "Dernier résultat",
  editer: "Éditer les fichiers",
  reglages: "Réglages",
};

const PICTOS_STATUT = { OK: "🟢", AVERTISSEMENT: "🟠", ECHEC: "🔴" };
const PICTOS_VERDICT = { PUBLIABLE: "🟢", A_VERIFIER: "🟠", ECHEC: "🔴" };

const etat = {
  suivi: null,          // { id }
  dernierRun: null,     // dernière réponse complète de /actions/runs/{id}
  minuteurSondage: null,
  minuteurAffichage: null,
};

let editeurFichierActuel = "theme.yaml";
let editeurSha = null;

// --------------------------------------------------------------------------
// Utilitaires généraux
// --------------------------------------------------------------------------
function attendre(ms) {
  return new Promise((resoudre) => setTimeout(resoudre, ms));
}

function obtenirPat() {
  return (localStorage.getItem(CLE_PAT) || "").trim();
}

// Base64 <-> UTF-8, SANS le piège classique de btoa/atob sur des caractères
// accentués. Ce projet a déjà été mordu une fois par une corruption d'encodage
// (mojibake) via un outil qui ne gérait pas l'UTF-8 correctement — theme.yaml
// et config.yaml sont pleins d'accents français, donc ce code doit être juste.
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
  const sec = s % 60;
  return min > 0 ? `${min} min ${sec}s` : `${sec}s`;
}

function afficherAvis(cible, type, texte) {
  const conteneur = typeof cible === "string" ? document.getElementById(cible) : cible;
  conteneur.innerHTML = "";
  const div = document.createElement("div");
  div.className = "avis " + type;
  div.textContent = texte;
  conteneur.appendChild(div);
}

// Traduit une erreur d'API en message actionnable — pas juste "HTTP 403".
function explicationErreur(e) {
  if (e && e.status === 401) return "Jeton invalide ou expiré — va dans Réglages pour le renouveler.";
  if (e && e.status === 403) return "Accès refusé — vérifie dans Réglages que le jeton couvre Actions et Contents en lecture/écriture sur Tiktok_Auto.";
  if (e && e.status === 404) return "Introuvable — vérifie que le jeton a bien accès au dépôt Tiktok_Auto.";
  if (e && e.status === 409) return "Conflit : quelque chose a changé entre-temps sur GitHub.";
  if (e && e.status === 422) return "Requête refusée par GitHub : " + e.message;
  return (e && e.message) || "Erreur inconnue.";
}

async function copierPresse(texte, idBouton) {
  try {
    await navigator.clipboard.writeText(texte);
  } catch {
    // Vieux WebView sans l'API Clipboard : repli sur execCommand.
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
    } catch { /* corps non JSON, tant pis */ }
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
// 204). On note donc l'id du run le plus récent AVANT de déclencher, puis on
// guette l'apparition d'un run dont l'id dépasse celui-là — c'est le nôtre,
// sans ambiguïté possible d'horloge ou de fuseau.
async function lancer(mode, forcer) {
  const avant = await idDuDernierRun();
  await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: { mode, force: forcer ? "true" : "false" },
    }),
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
  const bloc = document.getElementById("suivi-actif");
  bloc.classList.remove("masque");

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
      if (document.getElementById("ecran-resultat").classList.contains("actif")) {
        chargerResultat();
      }
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
  // Ticker d'affichage entre deux sondages : la durée affichée avance chaque
  // seconde sans multiplier les appels d'API.
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
    onglet.style.position = "relative";
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
      zone.innerHTML = '<p class="detail">Aucun résultat pour l’instant — lance une première vidéo depuis l’onglet Lancer.</p>';
    } else {
      afficherAvis(zone, "erreur", explicationErreur(e));
    }
    return;
  }

  // Le publish côté workflow a lieu AVANT que le job passe à "completed" :
  // s'il est déjà terminé, meta.json est forcément à jour pour CE run (ou le
  // pas de publication est un fait réel du run, pas un souci de timing). Un
  // run encore en cours peut en revanche montrer un résultat plus ancien.
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
    <div id="zone-credits" style="margin-top:10px"></div>
  `;

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

  // Vidéo
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

  // Description — accroche + hashtags, exactement ce qui se colle dans TikTok.
  const zoneLegende = zone.querySelector("#zone-legende");
  try {
    const legende = await recupererFichierResultat("legende.txt");
    zoneLegende.innerHTML = `
      <div class="ligne espace"><h2 style="margin:0">Description — à coller telle quelle</h2>
        <button class="petit" id="copier-legende">Copier</button></div>
      <pre class="bloc-copiable"></pre>`;
    zoneLegende.querySelector("pre").textContent = legende;
    zoneLegende.querySelector("#copier-legende").addEventListener("click", () => copierPresse(legende, "copier-legende"));
  } catch {
    zoneLegende.innerHTML = "";
  }

  // Crédits — séparés, à coller en premier commentaire.
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
    zoneCredits.querySelector("#copier-credits").addEventListener("click", () => copierPresse(credits, "copier-credits"));
  } catch {
    zoneCredits.innerHTML = "";
  }

  marquerPointResultat(false);
}

async function telechargerVideo(nomFichier, onProgress) {
  const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/video.mp4?ref=${BRANCHE_RESULTAT}`);
  const d = await r.json();
  if (!d.download_url) throw new Error("Pas d'URL de téléchargement pour cette vidéo.");

  // AUCUN en-tête personnalisé sur cet appel : le jeton d'accès est DANS
  // l'URL (query string), signé et à courte durée de vie. Ajouter un en-tête
  // Authorization ici redéclencherait un préflight CORS que ce serveur ne
  // gère pas — c'est exactement ce qui casse le téléchargement des assets de
  // Release, vérifié avant d'écrire ce fichier.
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
    await telechargerVideo(nomFichier, (fraction) => {
      barre.querySelector("div").style.width = Math.round(fraction * 100) + "%";
    });
    afficherAvis(avis, "ok", "Téléchargée.");
  } catch (e) {
    afficherAvis(avis, "erreur", explicationErreur(e));
  } finally {
    bouton.disabled = false;
  }
}

// --------------------------------------------------------------------------
// Écran ÉDITER
// --------------------------------------------------------------------------
async function choisirFichierEditeur(chemin) {
  editeurFichierActuel = chemin;
  document.getElementById("sous-onglet-theme").classList.toggle("actif", chemin === "theme.yaml");
  document.getElementById("sous-onglet-config").classList.toggle("actif", chemin === "config.yaml");
  await chargerEditeur(chemin);
}

async function chargerEditeur(chemin) {
  const zoneEtat = document.getElementById("editeur-etat");
  const zoneTexte = document.getElementById("editeur-texte");
  document.getElementById("editeur-avis").innerHTML = "";
  zoneTexte.disabled = true;
  zoneEtat.textContent = "Chargement…";
  try {
    const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${chemin}?ref=main`);
    const d = await r.json();
    editeurSha = d.sha;
    zoneTexte.value = decoderBase64Utf8(d.content);
    zoneTexte.disabled = false;
    zoneEtat.textContent = `${chemin} — chargé depuis main.`;
  } catch (e) {
    zoneEtat.textContent = explicationErreur(e);
  }
}

async function enregistrerEditeur() {
  const chemin = editeurFichierActuel;
  const texte = document.getElementById("editeur-texte").value;
  const zoneAvis = document.getElementById("editeur-avis");
  const bouton = document.getElementById("bouton-enregistrer");
  bouton.disabled = true;
  zoneAvis.innerHTML = "";
  try {
    const maintenant = new Date().toISOString().slice(0, 16).replace("T", " ");
    const r = await ghApi(`/repos/${OWNER}/${REPO}/contents/${chemin}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Édition de ${chemin} depuis le panneau — ${maintenant}`,
        content: encoderBase64Utf8(texte),
        sha: editeurSha,
        branch: "main",
      }),
    });
    const d = await r.json();
    editeurSha = d.content.sha;
    afficherAvis(zoneAvis, "ok", "Enregistré sur GitHub.");
  } catch (e) {
    if (e.status === 409) {
      afficherAvis(zoneAvis, "erreur", "Le fichier a changé entre-temps sur GitHub — rechargement du contenu actuel.");
      await chargerEditeur(chemin);
    } else {
      afficherAvis(zoneAvis, "erreur", explicationErreur(e));
    }
  } finally {
    bouton.disabled = false;
  }
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
  majEtatVerrouillage();
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
  majEtatVerrouillage();
}

function majEtatVerrouillage() {
  if (!obtenirPat()) {
    changerEcran("reglages");
    afficherAvis("reglages-avis", "info", "Colle ton jeton ci-dessus pour commencer.");
  }
}

// --------------------------------------------------------------------------
// Navigation entre écrans
// --------------------------------------------------------------------------
function changerEcran(nom) {
  document.querySelectorAll(".ecran").forEach((s) => s.classList.toggle("actif", s.id === "ecran-" + nom));
  document.querySelectorAll("nav.bas button[data-ecran]").forEach((b) => b.classList.toggle("actif", b.dataset.ecran === nom));
  document.getElementById("fil-ariane").textContent = LIBELLES_ECRAN[nom] || "";
  if (nom === "resultat") chargerResultat();
  if (nom === "editer") choisirFichierEditeur(editeurFichierActuel);
}

// --------------------------------------------------------------------------
// Démarrage
// --------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("nav.bas button[data-ecran]").forEach((b) => {
    b.addEventListener("click", () => changerEcran(b.dataset.ecran));
  });
  document.getElementById("bouton-reglages").addEventListener("click", () => changerEcran("reglages"));

  document.getElementById("bouton-lancer-production").addEventListener("click", () => lancerVideo("production"));
  document.getElementById("bouton-lancer-essai").addEventListener("click", () => lancerVideo("essai"));

  document.getElementById("bouton-rafraichir-resultat").addEventListener("click", chargerResultat);

  document.getElementById("sous-onglet-theme").addEventListener("click", () => choisirFichierEditeur("theme.yaml"));
  document.getElementById("sous-onglet-config").addEventListener("click", () => choisirFichierEditeur("config.yaml"));
  document.getElementById("bouton-enregistrer").addEventListener("click", enregistrerEditeur);

  document.getElementById("bouton-enregistrer-pat").addEventListener("click", enregistrerPat);
  document.getElementById("bouton-tester-pat").addEventListener("click", testerPat);
  document.getElementById("bouton-deconnecter").addEventListener("click", deconnecter);

  majEtatVerrouillage();

  const idSauvegarde = localStorage.getItem(CLE_DERNIER_RUN);
  if (idSauvegarde && obtenirPat()) {
    demarrerSuivi(Number(idSauvegarde));
  }
});
