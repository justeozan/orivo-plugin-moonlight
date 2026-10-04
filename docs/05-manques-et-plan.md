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
2. **Étape hôte — import côté Orivo : ✅ FAIT.** L'hôte lance `moonlight list
   <machine>` — le client du profil lui-même — et **écrit** un placeholder par
   application dans le dossier accordé, au début de l'import d'un profil en
   mode `stream`. Pas `GET /api/apps` : l'API web de Sunshine s'authentifie
   avec le **compte admin de son interface**, alors que le client, lui, est
   autorisé par le certificat établi à l'appairage — la même permission qui
   permet de streamer. Donc **aucun mot de passe n'existe dans cette
   fonctionnalité**, rien n'est stocké en clair, aucun certificat auto-signé
   n'est à accepter, et ce n'est pas spécifique à une implémentation d'hôte :
   c'est le protocole de Moonlight, donc Apollo répond pareil. Prix payé : il
   faut le binaire du client (qui est de toute façon ce qui joue le jeu), et
   une machine injoignable fait *attendre* `list` au lieu d'échouer — chaque
   appel est donc borné par un délai. Aucun changement de contrat : le guest
   n'écrit jamais, ne lance jamais rien, et ne voit que des fichiers. Un
   manifeste
   `.orivo-gamestream.json` posé à côté dit lesquels viennent du feed, et c'est
   la seule autorité pour en supprimer un — un `.stream` fait à la main survit
   à tous les rafraîchissements. Sans hôte configuré, le rafraîchissement est
   un no-op : le mode manuel du point 1 continue de marcher.
   `orivo/src-tauri/src/gamestream.rs`, `orivo/docs/gamestream.md`.
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
1. ~~**Wrapper choisi comme application**~~ — **plus nécessaire**, et jamais
   livré : le point 2 l'a rendu inutile avant qu'il ne le soit. L'application
   du profil est le binaire Moonlight.
2. **Étape ABI — un mode `stream` : ✅ FAIT.** `PluginLaunchMode::Stream` et
   `RunnerLaunchMode::Stream` existent côté Orivo, et la forme retenue ne fait
   pas porter hôte+app par la réponse du guest du tout : le plugin ne nomme que
   **le mot** `stream`, et l'hôte lit hôte+app dans le placeholder qu'il a
   lui-même écrit et qu'il revalide. Une allowlist devient alors inutile — il
   n'y a rien à mettre sur liste, le plugin n'ayant prononcé aucune chaîne qui
   atteigne la liste d'arguments. Le mode est de plus une **permission du
   profil**, posée par l'utilisateur, que `validate-profile` ne voit jamais :
   l'hôte refuse le lancement si l'intention du plugin et la permission du
   profil ne s'accordent pas, dans les deux sens. Ce dépôt renvoie `"stream"`
   depuis `v0.2.0`.
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
3. ~~modale de doublon~~ : **FAIT, et autrement.** Il n'y a pas deux cartes à
   réconcilier, parce qu'il n'y en a plus qu'une : l'import d'un jeu que la
   bibliothèque porte déjà ajoute une *façon de le lancer* à la carte existante
   plutôt qu'une seconde carte (schéma catalogue v9,
   `alternate_launch_targets`). Le choix se pose au clic sur Play, dans une
   liste ancrée au bouton — rien n'est modal dans Orivo. Les titres sont
   comparés ponctuation et casse mises de côté ; les suffixes d'édition sont
   délibérément conservés, donc `Cyberpunk 2077` et `Cyberpunk 2077: Ultimate
   Edition` restent deux jeux.

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

## Phase 1 — Utilisable (dépassée par la Phase 2)

Cette phase existait pour livrer quelque chose d'utilisable **sans toucher à
Orivo**. Deux de ses quatre points ont été rendus inutiles par la Phase 2, qui
a été faite d'abord : le wrapper (point 1) et l'outil d'écriture des
placeholders (point 2) sont tous les deux remplacés par du code hôte. Ce qui
reste :

1. ~~Wrapper par profil~~ — remplacé par le mode `stream` (§3.2) ;
2. ~~Écriture des placeholders par un script~~ — remplacée par le feed hôte
   (§1.2) ;
3. **Détection** : accord manuel d'un second dossier + reconnaissance des noms
   de clients dans `discover-page`/`validate-profile`, en attendant l'UI ;
4. **Installation dans Orivo** : empaqueter le `.orivo-plugin`, installer via
   le canal dev, créer un profil, le passer en mode *Streams from another
   machine*, enregistrer l'hôte dans Réglages, accorder un dossier, importer,
   Play.

*Sortie : un utilisateur avancé streamme réellement depuis Orivo.*

## Phase 2 — Évolutions de contrat / d'ABI (décisions Orivo)

1. ✅ **Mode de lancement `stream`** (§3.2) : a fait disparaître le wrapper.
   Fait côté Orivo ; ce dépôt le renvoie depuis `v0.2.0`. N'a demandé **aucune
   révision du WIT** : `mode` est déjà un `string` dans le contrat v1, et la
   baseline `wit-v1-baseline.json` est donc inchangée — c'est le mot accepté
   qui a bougé, pas la forme. Le feed hôte (§1.2) n'en a pas demandé non plus.
2. **Plateforme transmise au guest** (§2.3) : rend la matrice d'installation
   applicable par le plugin ;
3. **Import réseau** (§1.3) : synchro distante réelle (découverte Sunshine,
   `moonlight list`, pairage) avec allowlist `networkDomains` déjà prévue par
   le manifeste.

Chacun est indépendant ; l'ordre proposé est celui du rapport
utilisateur/risque. Les deux restants exigent une révision revue du WIT et un
relevé de la baseline `wit-v1-baseline.json` côté Orivo — le premier, lui, n'en
a pas eu besoin, pour la raison dite ci-dessus.

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
