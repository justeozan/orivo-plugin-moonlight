# 01 — Le contexte Orivo : ce que permet, et ce que refuse, la plateforme

> Vérifié sur l'arbre Orivo au commit `db03c6c` (`~/repos/orivo`). Toutes les
> références `fichier:ligne` pointent sur ce commit. Si Orivo a bougé, re-vérifier
> avant de faire confiance à un nombre de ce document — `wit/README.md` explique
> comment re-synchroniser le contrat.

## 1. Ce qu'est Orivo

Orivo est une bibliothèque de jeux (launcher) multi-plateformes, construite en
Rust + Tauri (`src-tauri/`), avec une interface WebView (`src/app.ts` et
compagnons). Sa particularité ici : **un système de plugins WebAssembly** qui
laisse des tiers ajouter des « runners » (émulateurs, et demain clients de
streaming) sans que l'application connaisse leur existence.

Un runner = un composant WASM que l'hôte Orivo appelle pour trois opérations :
valider un profil, lister une bibliothèque, préparer un lancement. **L'hôte
conserve toujours la propriété du processus** : le plugin ne renvoie jamais une
commande, un chemin exécutable ni des arguments.

## 2. La pile technique d'un plugin

| Élément | Valeur vérifiée | Source |
|---|---|---|
| Format | WebAssembly Component (pas un module) | `src-tauri/src/plugin_runtime.rs` |
| Runtime hôte | Wasmtime `=44.0.0` (component-model, cranelift) | `src-tauri/Cargo.toml:55` |
| Contrat WIT | `package orivo:plugin@1.0.0` — **gelé** | `wit/orivo-plugin.wit` |
| Générateur de bindings guest | `wit-bindgen 0.62.0` (pinné) | `plugins/ryujinx/Cargo.toml` |
| Outil de composant | `wasm-tools 1.246.2` (pinné, version *vérifiée*) | `plugins/ryujinx/build.sh` |
| Cible | `wasm32-unknown-unknown` | idem |
| Garde-fou du contrat | `sdk/orivo-plugin-sdk/tests/wit_compatibility.rs` compare à `tests/wit-v1-baseline.json` | SDK |
| Échantillon réel en arbre | `plugins/ryujinx/` (runner Nintendo Switch, installable) | — |

Le contrat est **gelé** : toute rupture fait échouer la baseline. Une évolution
du contrat est une décision côté Orivo, jamais côté plugin (voir
`orivo/wit/README.md`).

## 3. Les quatre mondes, et lequel est réel

```wit
world runner-plugin { import host-journal; import host-files; export plugin-core; export runner; }
world source-plugin { export plugin-core; export source; }
world metadata-plugin { export plugin-core; export metadata; }
world ui-plugin      { export plugin-core; export ui-contrib; }
```

- **`runner-plugin` est le seul monde invocable aujourd'hui.** L'hôte n'appelle
  que lui (`orivo/wit/README.md`, et `sdk/orivo-plugin-sdk/src/simulate.rs` le
  dit explicitement).
- `source`, `metadata`, `ui-plugin` sont **contract-only** : le WIT existe, aucune
  voie hôte ne les appelle. En particulier **toute contribution d'UI
  (bouton, badge, réglage) est théorique** : Orivo ne rend rien du tout pour
  l'instant.

Conséquence pour nous : un plugin Moonlight/Sunshine ne peut *aujourd'hui* être
qu'un **runner**. L'installation, les modales et les boutons sont du travail
côté Orivo (voir `05-manques-et-plan.md`).

## 4. Ce que l'hôte met réellement à disposition du guest

Deux imports, et rien d'autre :

| Import | Ce qu'il fait | Ce qu'il ne fait pas |
|---|---|---|
| `host-journal` | `log(level, message)` — journal interne, tronqué | n'atteint jamais la WebView tel quel |
| `host-files` | `list-directory(grant)`, `read-file(grant, name)` | **non récursif**, pas de symlinks, pas d'écriture, pas de chemin |

Et par conséquent, **ce qui n'existe pas** :

- **Pas de réseau.** Aucun import WIT ne sert `network_fetch`. La capability
  `network_fetch` du manifeste (couplée à `networkDomains`, `plugin_manifest.rs:216`)
  est une *déclaration* utilisée par l'extension `installer` — c'est **l'hôte**
  qui télécharge, jamais le guest. Un runner qui déclarerait `network_fetch` ne
  gagnerait aucun octet de réseau.
- **Pas d'OS.** Le guest n'apprend jamais sur quelle plateforme il tourne : ni
  import, ni champ du manifeste, ni argument des appels. Aucun Windows/macOS/
  Linux/Android ne transite dans le contrat v1.
- **Pas d'horloge, pas d'aléatoire, pas de WASI du tout** (`plugin_runtime.rs`,
  constante `HOST_JOURNAL_IMPORT` et commentaire qui suit : « there is no WASI
  here, general or otherwise, so a package that expects a clock, a random
  source, a socket or a preopened directory is refused before it is ever
  instantiated »).
- **Pas d'exécution de processus, pas d'IPC, pas d'accès SQLite/DOM.**

## 5. Le manifeste : les règles qui nous concernent

`src-tauri/src/plugin_manifest.rs` (`PluginManifest::validate`) :

- `id` : reverse-DNS, ≥ 3 labels → `com.orivo.gamestream` convient ;
- `version` : semver ; doit être **cohérente** avec `Cargo.toml` et la réponse
  de `get-identity` (le registre les compare avant installation) ;
- `sdk`: `"orivo-plugin@1"` ; `minOrivoVersion` optionnel ;
- **un seul artefact `kind: "component"`**, ≤ 64 MiB ; package ≤ 96 MiB ;
- payloads interdits dans le package : `dylib/so/dll/exe/app/sh/js/py/rb` —
  **on ne livre pas de script ni de binaire natif dans le plugin** (assets
  limités à `assets/*.{json,svg,png,webp,jpg,jpeg,ftl}`) ;
- couplages : `runner` ⇒ capability `runner_prepare` (`:221`) ;
  `installer` ⇒ `network_fetch` (`:229`) ⇒ `networkDomains` non vide (`:216`) ;
  `files_read` est ce qui rend `host-files` linkable ;
- le WIT impose aussi que le lien d'un import **non déclaré au manifeste**
  n'existe pas : déclarer moins, c'est refuser plus tôt.

Notre manifeste : `extensions: ["runner"]`, `capabilities: ["runner_prepare",
"files_read"]`, `networkDomains: []`. On **n'a pas** `installer` — voir
`05-manques-et-plan.md` (§5) : l'extension installer est mono-instance et
déjà occupée par le plugin Quiky.

## 6. Budgets et limites (plugin_runtime.rs)

Plafonds par invocation, tous vérifiés :

| Plafond | Valeur | Ligne |
|---|---|---|
| Fuel « probe » (identity/health) | 5 000 000 / 250 ms | `:230-231` |
| Fuel « interactive » (validate, prepare-launch) | 50 000 000 / 1 s | `:226-227` |
| Fuel « discovery » (discover-page) | 500 000 000 / 5 s | `:228-229` |
| Mémoire d'une instance | 64 MiB | `:232` |
| Mémoire toutes instances | 256 MiB | `:233` |
| Host-calls par invocation | 256 | `:113` |
| Entrées par `list-directory` | 256 (scan stoppé à 4096, triées par nom, troncature annoncée au journal) | `:114-118`, `:1896-1912` |
| Octets par `read-file` | 1 MiB | `:119` |
| Lecture totale par invocation | 8 MiB | `:123` |
| Nom d'entrée | 255 octets | `:124` |
| Journal : messages / entrées / octets par host-call | 512 / 256 / 4096 | `:125`, `:138-139` |
| Jeux par page renvoyée | 100 (et **≤ la limite demandée**, sinon erreur) | `:146`, `:3457-3460` |
| Ids opaques (références, curseur) | 256 octets, charset `[A-Za-z0-9._\-:]` | `:143-145`, `plugin_manifest.rs:499` |
| Texte (titres, messages) | 512 octets | `:144` |
| Échecs consécutifs avant mise au park | 3 | `:170` |

Le tick d'epoch est de 10 ms (`:102`) : même un busy-loop guest est tué dans
les temps.

## 7. Le cycle de vie d'un runner (vérifié dans `runner_host.rs`)

1. **Installation** — canal dev : `install_plugin_from_file`
   (`plugin_installer.rs:472`) choisit un fichier `.orivo-plugin`
   (**tar gzippé**, borne en mémoire), politique `SignaturePolicy::AllowUnsigned`
   → installation en **channel développement** (non signé, jamais mis à jour
   automatiquement, grants liés aux octets exacts). Le canal officiel demande
   une clé de signature qui n'existe pas encore (`docs/TODOS.md:90`).
2. **Création de profil** — sélecteur de fichiers natif pour
   `profile.application` (ex. le binaire `moonlight`) :
   `create_runner_profile`.
3. **Grant** — « Add a folder » → slot **`games`**
   (`runner_commands.rs:47`, `DEFAULT_DIRECTORY_SLOT`), stocké comme
   `<profile-id>:<slot>` (`catalog.rs:3212`), au plus **32 dossiers** par
   profil (`catalog.rs:3040`). Le chemin ne quitte jamais l'hôte : le plugin
   reçoit le *nom du slot*.
4. **Validation** — `validate-profile(profile-id, display-name)`
   (`runner_host.rs:632`) tourne **avec les grants déjà résolus** : le plugin
   *peut* lister le dossier… sauf au tout premier appel, où aucun dossier n'est
   encore accordé.
5. **Import** — `start_runner_import` → `discover-page` paginé → chaque
   candidat est résolu **en un fichier réel** dans un dossier accordé
   (`resolve_page_candidates`, `runner_host.rs:1445`) → catalogue. Ce qui ne
   résout pas est **silencieusement skippé**.
6. **Lancement** — voir §8.
7. Re-validation / statut du profil : `apply_profile_validation`
   (`runner_host.rs:659`) → `Valid` ou `Rejected` + message.

Côté WebView, la séquence est pilotée par les commandes Tauri
(`get_runner_plugins`, `grant_runner_profile_directory`, `start_runner_import`,
`launch_game`, événement `plugin-install-status`), et l'UI affiche encore
Moonlight/Sunshine en « COMING SOON » (`src/app.ts:2425`).

## 8. Le pipeline de lancement : la contrainte qui tout tient

`prepare_runner_launch` (`runner_host.rs:1130`), dans cet ordre strict :

1. profil utilisable, entrée présente dans l'inventaire (`:1137-1140`) ;
2. **le fichier de jeu est revérifié sur disque** dans un dossier accordé (`:1145`) ;
3. capability `runner_prepare` tenue (`:1149`) ;
4. `profile.application` résolue et exécutable (`resolve_application`, `:1051`,
   canonisée, `is_executable`) ;
5. appel `prepare-launch` du plugin (budget interactif) → intent validé :
   `runner_id`, `profile_id`, `game_reference` doivent être **exactement ceux
   de l'appel**, `mode` doit être `"default"` — toute autre valeur est rejetée
   (`plugin_runtime.rs:3541-3544`) ;
6. construction du processus (`:1189`) :

```rust
PluginLaunchMode::Default => PreparedRunnerLaunch {
    working_directory: application.parent(),
    program: application,          // le binaire choisi par l'utilisateur
    arguments: vec![game_file],    // EXACTEMENT UN argument : le fichier
    title: entry.title.clone(),
}
```

Le match est **exhaustif et délibérément non défaillant** : « A second mode is
an ABI decision, not a plugin's » (`runner_host.rs:1184-1188`).
`Command::new(program).args(arguments)` (`:1102`) : aucune citation, aucun
shell, aucun splitting — **un fichier, un argument**.

C'est la contrainte centrale du projet : `moonlight stream <hôte> <jeu>` exige
**deux** arguments après l'action, le contrat v1 n'en autorise **qu'un**, et ce
fichier doit exister localement. Toute la spécification
(`04-specification-plugin.md`) et tous les manques (`05-manques-et-plan.md`)
tournent autour de ce fait.

## 9. L'identité d'une carte de jeu

Une carte runner est `runner:plugin:profil:sha256(plugin\0profil\0réf)`
(`runner_host.rs:1592`, `runner_game_id`). Deux profils = deux cartes, même
titre — c'est exactement le cas « jeu local + jeu distant » qui appellera une
modale côté Orivo (`05-manques-et-plan.md`, §4).

## 10. Plateformes

Orivo vise macOS/Windows/Linux (et Android via Tauri ; `gen/apple` existe pour
iOS). **Le runtime plugin n'est pas prouvé sur mobile** : la CI ne teste le
paquet de plugins que sous Windows et Linux, et `install_plugin_from_file` est
coupé sous mobile (`#[cfg(mobile)] return Ok(None)`). Wasmtime y joue contre
nous aussi (JIT/permissions sur iOS). À traiter comme un risque ouvert, pas
comme une plateforme cible.
