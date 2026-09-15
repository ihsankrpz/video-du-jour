# Vidéo du jour — panneau de contrôle

Une page web, sans application, pour lancer et récupérer la vidéo quotidienne
produite par [`Tiktok_Auto`](https://github.com/ihsankrpz/Tiktok_Auto)
directement depuis un téléphone — sans passer par l'application GitHub.

**Ce dépôt est public et ne contient aucun secret.** Le dépôt piloté
(`Tiktok_Auto`) reste privé. La page parle en direct à l'API GitHub avec un
jeton que tu colles une seule fois dans ton navigateur ; il n'est jamais
envoyé ailleurs qu'à `api.github.com` et `raw.githubusercontent.com`.

## Adresse

```
https://ihsankrpz.github.io/video-du-jour/
```

Ouvre-la dans Safari ou Chrome sur le téléphone, puis **Partager → Sur l'écran
d'accueil** (iPhone) ou **⋮ → Ajouter à l'écran d'accueil** (Android). Tu
obtiens une icône qui ouvre directement le panneau, plein écran, sans barre
d'adresse.

## Mise en service, une seule fois

1. Ouvre la page. Sans jeton enregistré, elle s'ouvre directement sur
   **Réglages**.
2. Crée un jeton **fine-grained**, restreint au seul dépôt `Tiktok_Auto` :
   - github.com → photo de profil → **Settings**
   - **Developer settings** (tout en bas) → **Personal access tokens** →
     **Fine-grained tokens** → **Generate new token**
   - *Resource owner* : ton compte
   - *Repository access* : **Only select repositories** → `Tiktok_Auto`
   - *Permissions* → *Repository permissions* :
     **Actions** : Read and write · **Contents** : Read and write
   - *Expiration* : 90 jours par exemple — GitHub rappelle de le renouveler
   - **Generate token**, copie-le (il ne sera plus jamais affiché)
3. Colle-le dans le champ de la page, **Enregistrer**, puis **Tester** pour
   confirmer la connexion.

Ces étapes sont aussi rappelées directement dans l'écran Réglages de la page.

## Thème jour / nuit

Trois états, via l'icône en haut à droite ou l'écran Réglages : **Auto** (suit
le réglage du téléphone), **Clair** (blanc) ou **Sombre** (noir). Le choix est
retenu sur l'appareil, et appliqué avant même le rendu de la page pour éviter
un flash blanc à l'ouverture.

## Utilisation

- **Lancer** — Produire la vidéo (`production`) ou lancer un Essai
  (`bac à sable`, ne consomme pas l'anti-doublon). Le suivi apparaît juste
  au-dessus et se met à jour tout seul, ~5 à 7 minutes.
- **Résultat** — description prête à coller (accroche + hashtags), crédits
  séparés à coller en premier commentaire, et un bouton qui enregistre le
  `.mp4` directement dans le téléphone. Une pastille apparaît sur cet onglet
  quand un résultat frais attend.
- **Éditer** — un **formulaire**, pas des fichiers : interrupteurs, listes
  déroulantes et champs texte pour ce qui se règle au quotidien (voix off,
  musique, source des images, banque distante, durée visée, angles, hashtags,
  voix…). Chaque réglage porte une explication de ce qu'il change. Un onglet
  **Avancé** garde le fichier brut pour ce que le formulaire n'expose pas —
  dont les NOMS des bacs Supabase, volontairement laissés là : les changer
  depuis le téléphone rendrait orphelins tous les clips déjà déposés.

  L'enregistrement fait des remplacements **chirurgicaux** : seule la valeur
  change, jamais la ligne entière. Les commentaires de `config.yaml` — qui sont
  la documentation du projet — survivent intacts, y compris ceux en fin de
  ligne. C'est vérifié par un test qui rejoue les 22 champs contre les vrais
  fichiers et contrôle qu'aucun autre champ ni commentaire ne bouge.
- **Banque** — les trois bacs de la banque distante Supabase : chaque clip avec
  son aperçu jouable, son auteur, sa licence et son poids. Suppression à
  l'unité, ajout depuis la galerie du téléphone. Un média présent sans entrée
  d'index est signalé : il occupe le quota sans pouvoir jamais servir.
- **Réglages** — gérer le jeton, tester la connexion, l'effacer de l'appareil,
  et purger le stockage GitHub.

  Le volet **Anciens** de l'onglet Résultat liste les vidéos encore
  téléchargeables, avec légende, hashtags et crédits séparés et copiables. Sa
  colonne vertébrale est l'état RÉEL des Releases : une vidéo élaguée en
  disparaît, au lieu d'offrir un lien mort.

## Pourquoi cette page ne détient aucune clé Supabase

Elle pourrait parler à Supabase directement : l'API Storage est parfaitement
utilisable depuis un navigateur — préflight `200`, `Access-Control-Allow-Origin: *`,
en-têtes `apikey` et `authorization` autorisés, vérifié. Mais la seule clé dont
le projet dispose contourne **toutes** les règles de sécurité de la base, et une
page publique n'est pas un endroit pour ça.

La séparation retenue :

| | Comment | Délai |
|---|---|---|
| Consulter la banque | catalogue publié par le runner, avec des **URLs signées** | immédiat |
| Ajouter / supprimer | workflow `maintenance.yml` : le runner agit | ~40 s |

Une URL signée est pré-authentifiée : la page la suit sans le moindre en-tête,
donc sans préflight, et sans jamais détenir de secret. Elle honore les requêtes
Range, ce qui permet à une balise `<video>` d'y naviguer. Le runner les refait à
chaque production ; elles valent 30 jours.

Pour l'ajout, le fichier transite par une branche-sas `depot-banque` — les
entrées d'un `workflow_dispatch` sont des chaînes plafonnées, un média en base64
les ferait éclater. Le runner récupère le fichier puis **remplace la branche par
un commit orphelin vide** : rien n'y séjourne.

## Pourquoi une branche `dernier-resultat`, et pas la Release ?

`Tiktok_Auto` publie déjà chaque vidéo en Release GitHub — pratique à
parcourir sur github.com, mais **son asset ne peut pas être récupéré par une
page web** : le téléchargement passe par une redirection vers Azure Blob
Storage, et cette réponse ne renvoie aucun en-tête CORS (vérifié avant
d'écrire ce panneau). `fetch()` y échoue systématiquement.

Le workflow pousse donc aussi le résultat sur une branche dédiée,
`dernier-resultat`, en un **commit unique et orphelin** à chaque run — jamais
d'historique qui grossit. Un fichier suivi par git expose, via l'API Contents,
un `download_url` portant un jeton signé dans l'URL elle-même : `fetch()` peut
l'appeler sans aucun en-tête personnalisé, donc sans préflight CORS, et le
serveur répond avec les en-têtes qu'il faut. C'est ce que lit réellement cette
page ; la Release reste l'archive consultable sur github.com.

## Sécurité — ce qu'il faut savoir avant de coller le jeton

- Le jeton reste dans le **stockage local de ce navigateur**, sur cet
  appareil. Il n'est jamais transmis à un tiers.
- Il est restreint à un seul dépôt (`Tiktok_Auto`) et à deux permissions
  (Actions, Contents) : quelqu'un qui l'obtiendrait ne pourrait rien faire
  ailleurs sur ton compte GitHub.
- Le pire abus possible avec ce jeton est de déclencher des productions
  (donc de consommer les crédits Anthropic/ElevenLabs) ou d'éditer
  `theme.yaml`/`config.yaml`. Ce n'est pas une fuite de données personnelles.
- **Se déconnecter** (bouton dans Réglages) l'efface de l'appareil. Le
  révoquer côté GitHub (Settings → Personal access tokens) est plus rapide en
  cas de doute.

## Fichiers

```
index.html    la page (structure)
style.css     apparence, thème clair / sombre / automatique
app.js        toute la logique — commentée, sans dépendance externe
manifest.json pour « Ajouter à l'écran d'accueil »
icone-*.png   icône de l'app
```

Aucune dépendance, aucun outil de build : ce sont des fichiers statiques,
modifiables directement dans l'éditeur web de GitHub si besoin.
