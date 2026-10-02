# 05 — Les manques, et le plan

Chaque manque est un **fait du contrat ou de l'hôte**, pas un TODO de code. Le
plan est ordonné pour que chaque phase produise quelque chose d'utilisable sans
dépendre de la suivante.

## §1 — Il n'y a pas de réseau dans le guest

**Le fait.** Aucun import WIT ne sert `network_fetch`. Le guest ne peut ni
découvrir un hôte Sunshine, ni appeler son API (`/api/apps`), ni exécuter
`moonlight list <hôte>`, ni pairer. La capability `network_fetch` du manifeste
est une déclaration pour l'extension `installer` — c'est **l'hôte** qui
télécharge (`plugin_manifest.rs:216`).

**Ce que ça bloque.** Tout le volet « synchro des jeux distants » : la
bibliothèque distante ne peut être ni lue ni mise à jour par le plugin.

**Trajectoire (dans l'ordre).**
1. **v0.1 — placeholders manuels** : le dossier `games` *est* la bibliothèque ;
   l'utilisateur y pose (ou un futur outil Orivo y écrit) les jeux distants.
   Fait aujourd'hui, sans rien changer à Orivo.
2. **Étape hôte — import côté Orivo** : un parcours natif (Tauri a le réseau)
   qui interroge Sunshine/`moonlight list` et **écrit** les placeholders dans le
   dossier accordé. Aucun changement de contrat requis, mais du code Orivo —
   et l'écriture reste de l'hôte, puisque le guest n'écrit jamais.
3. **Étape ABI — un vrai import réseau** : exposer `network_fetch` au guest
   (import WIT + allowlist `networkDomains` déjà en place dans le manifeste),
   avec les mêmes garde-fous que partout ailleurs (budget, domaine, pas de
   socket brut). C'est une **révision de contrat v2**, à discuter côté Orivo
   (`orivo/wit/README.md` décrit la procédure ; la baseline du SDK devra être
   relevée, opération délibérée et revue).

## §2 — Le guest ne connaît pas l'OS

**Le fait.** Ni import, ni champ, ni argument ne disent au plugin s'il tourne
sur Windows, macOS, Linux, Android ou iOS (`01-contexte-orivo.md` §4).

**Ce que ça bloque.** La matrice « proposer Moonlight/Sunshine/Artemis/Apollo
selon la plateforme » (`04` §3) côté plugin, et toute détection qui dépendrait
de chemins propres à une plateforme.

**Trajectoire.**
1. **v0.1 — par profil** : l'UI d'Orivo, elle, connaît l'OS ; c'est elle qui
   doit afficher la matrice dans le parcours de création de profil. Le nom du
   profil porte l'information ensuite.
2. **Détection par listing** : `list-directory` sur un dossier accordé
   (`/Applications`, `Program Files`) et reconnaissance de `Moonlight.app` /
   `Sunshine` — faisable *si* le parcours Orivo accordé ce second dossier
   (le contrat permet plusieurs slots ; l'UI n'en expose qu'un).
3. **Étape ABI** : transmettre la plateforme à `validate-profile` (nouveau
   champ) ou via un import `host-platform`. Révision de contrat, comme §1.3.

## §3 — L'exécution à un seul argument ne peut pas lancer un stream

**Le fait.** `PluginLaunchMode::Default` → `program = profile.application`,
`arguments = [fichier_de_jeu]` **exactement** (`runner_host.rs:1184-1194`), et
le match est exhaustif volontairement : « A second mode is an ABI decision, not
a plugin's ». Le mode renvoyé par le plugin doit être `"default"`, sinon
`InvalidResult("intent mode")`. Le CLI Moonlight exige
`moonlight stream <hôte> <jeu>` — l'action plus **deux** arguments.

**Ce que ça bloque.** Un clic **Play** qui ouvre Moonlight *sur le bon jeu*, sans
artifice.

**Trajectoire (dans l'ordre).**
1. **Wrapper choisi comme application (v0.1, sans rien changer à Orivo)** :
   l'exécutable du profil est un script exécutable (macOS/Linux) ou un helper
   `.exe` (Windows) qui reçoit le placeholder et fait `stream <hôte> <jeu>`.
   Le contenu du `.stream` (§5 de `04`) deviendra alors la source de
   `<hôte>/<jeu>` ; en attendant, le wrapper peut le coder en dur. Déjà
   documenté, pas encore livré (les wrappers sont des fichiers **utilisateur**,
   hors du package — le package ne peut pas contenir de script).
2. **Étape ABI — un mode `stream` (ou similaire)** : ajouter une variante à
   `PluginLaunchMode`, décidée et implémentée **côté Orivo** : nouvelle valeur
   acceptée dans `plugin_runtime.rs:3541`, nouveau bras dans le match de
   `runner_host.rs:1184`, et une forme de réponse du guest qui porte hôte+app
   **sans** devenir une ligne de commande arbitraire (ex. ids opaques
   supplémentaires que l'hôte valide contre une allowlist, à définir). Orivo
   a déjà noté « élargir runner-profile et modes de lancement » dans ses plans
   ; c'est ici que cela se range.
3. **Alternative hôte** : un lancement « intent » natif (comme Winlator sur
   Android, qui passe une intent à une autre application) — même endroit
   d'implémentation, même décision d'ABI.

## §4 — L'UI n'existe pas : installation, modale, Play

**Le fait.** `ui-plugin` est **contract-only** : Orivo n'appelle jamais
`contributions()`. Aucun bouton, badge, réglage ou surface d'installation
n'est rendu pour un plugin. L'écran Plugins de l'app affiche Moonlight /
Sunshine en « COMING SOON » (`src/app.ts:2425`).

**Ce que ça bloque.** (a) proposer l'installation des clients, (b) la modale
« local + distant », (c) un Play qui a l'air natif (le runner *a* déjà son Play
dans la bibliothèque — c'est le *parcours d'installation* qui n'existe pas).

**Trajectoire.** Travail **Orivo**, pas plugin :
1. parcours « Add a runner » qui montre la matrice de §2 et ouvre le bon lien
   de téléchargement (statique, côté hôte — le plugin ne déclare rien) ;
2. détection affichée (statut du profil / message de `validate-profile`) ;
3. modale de doublon : les deux cartes existent déjà avec leur clé
   `runner:plugin:profil:hash` — comparer titre/profil suffit à la détecter
   (`04` §7).

## §5 — L'extension `installer` est occupée et n'est pas la nôtre

**Le fait.** `PluginRegistry::installer_plugin()` renvoie **le premier**
plugin portant l'extension `installer` (`plugin_registry.rs:90`) — slot à un
seul, déjà tenu par Quiky. Qui plus est, l'implémentation hôte est celle de
Quiky : catalogue `assets/catalog.json`, `installer_kind` borné à
`nsis`/`inno`, préfixe Wine — c'est un installateur de jeux Windows, pas un
installateur de clients de streaming multi-OS.

**Conséquence.** Ce plugin **ne déclare pas `installer`**. C'est une décision,
pas une omission : le déclarer éclipserait (ou serait éclipsé par) Quiky et
présenterait un catalogue que l'hôte ne saurait pas exécuter pour
macOS/Linux/Android.

## §6 — Mobile : runtime non prouvé

**Le fait.** La CI ne teste les paquets de plugins que sous Windows et Linux ;
`install_plugin_from_file` est coupé sous mobile (`#[cfg(mobile)]`) ; Wasmtime
a un problème structurel d'iOS (pages JIT/exécution). Rien ne prouve qu'un
plugin tourne sur Android, encore moins sur iOS.

**Conséquence.** Les cibles Android/iOS de la matrice d'installation (§2) sont
à traiter **côté hôte**, là où le code tourne déjà nativement — pas en misant
sur le runtime plugin. Ré-évaluer si Orivo officialise un runtime mobile.

## §7 — Le registre officiel n'existe pas encore

**Le fait.** `docs/TODOS.md:90` : « Hébergement du registre + détenteur de clé »
est ouvert. Sans clé de signature ni index hébergé, il n'y a pas de
distribution officielle.

**Conséquence.** Le canal de développement est le chemin réel aujourd'hui :
fichier `.orivo-plugin` (tar gzippé) → `install_plugin_from_file` →
`SignaturePolicy::AllowUnsigned` → installation « développement » (liée aux
octets exacts, jamais mise à jour automatiquement). C'est aussi ce que Ryujinx
utilise (`orivo/docs/ryujinx-runner.md`).

## §8 — Les bornes de données à connaître

| Borne | Valeur | Effet |
|---|---|---|
| Entrées visibles par dossier | 256 (scan 4096, tri nom) | la queue d'un gros dossier est **inatteignable**, sans erreur |
| Nom de fichier référençable | ≤ 127 octets (hex ≤ 256) | au-delà : fichier écarté avec une ligne au journal |
| Jeux par page | ≤ `limit`, ≤ 100 | au-delà : erreur, page rejetée |
| Cartes par profil | pas de plafond métier, mais 32 dossiers max | la capacité suit le nombre de fichiers portés par ces dossiers |

Aucun de ces points ne se contourne côté plugin ; les trois premiers doivent
être dits à l'utilisateur, pas découverts.

---

# Le plan

## Phase 0 — Socle (FAIT dans ce dépôt)

- Contrat copié et gelé vérifiable (`wit/README.md`) ;
- documentation du contexte Orivo, de l'interface, des règles, du cahier des
  charges et de ces manques ;
- squelette **compilable et validé** : `./build.sh` → digest, `validate`,
  `check`, `simulate` passent (discover-page sur fixtures, prepare-launch,
  refus sans grant) ;
- manifeste de canal dev `package/manifest.json` (runner + `files_read`).

## Phase 1 — Utilisable sans toucher à Orivo

1. **Wrapper par profil** : documenter (déjà) + livrer une recette de wrapper
   macOS/Linux et le helper Windows (hors package) ;
2. **Écriture des placeholders** : petit outil/script hôte (ou manuel) qui
   remplit le dossier `games` — format `.stream` figé (`04` §5) ;
3. **Détection** : accord manuel d'un second dossier + reconnaissance des noms
   de clients dans `discover-page`/`validate-profile`, en attendant l'UI ;
4. **Installation dans Orivo** : empaqueter le `.orivo-plugin`, installer via
   le canal dev, créer un profil, accorder un dossier, importer, Play (avec
   wrapper).

*Sortie : un utilisateur avancé streamme réellement depuis Orivo.*

## Phase 2 — Évolutions de contrat / d'ABI (décisions Orivo)

1. **Mode de lancement `stream`** (§3.2) : fait disparaître le wrapper ;
2. **Plateforme transmise au guest** (§2.3) : rend la matrice d'installation
   applicable par le plugin ;
3. **Import réseau** (§1.3) : synchro distante réelle (découverte Sunshine,
   `moonlight list`, pairage) avec allowlist `networkDomains` déjà prévue par
   le manifeste.

Chacun est indépendant ; l'ordre proposé est celui du rapport
utilisateur/risque. Chacun exige une révision revue du WIT et un relevé de la
baseline `wit-v1-baseline.json` côté Orivo.

## Phase 3 — Expérience Orivo (UI hôte)

1. parcours « Add a runner » avec matrice d'installation par OS ;
2. statut de détection visible (profil validé + message) ;
3. modale « local + distant » (détection sur les clés de cartes) ;
4. retirer le « COMING SOON » (`src/app.ts:2425`) une fois 1–3 livrés ;
5. éventuellement, extension `installer` multi-plateforme **si** Orivo décide
   de sortir du slot mono-instance de §5.

## Ce qui reste ouvert et assumé

- clé de signature et hébergement du registre (§7) — hors code ;
- runtime mobile (§6) — hors périmètre tant qu'Orivo ne le garantit pas ;
- l'extension `installer` pour nos clients (§5) — refus délibéré en attendant
  une refonte hôte.
