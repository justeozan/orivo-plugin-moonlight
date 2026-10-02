# 03 — Les règles de construction : ce qui fait échouer un plugin, vérifié

Chaque règle ici a une raison hôte et, quand elle casse, un message d'erreur
réel. Elles sont regroupées parce qu'elles sont ce que `04-specification-plugin.md`
et `src/lib.rs` mettent en œuvre — et ce qu'aucun commentaire de code ne doit
contredire.

## 1. La référence opaque : `x:` + hexadécimal minuscule

- **Le problème.** L'hôte retrouve le fichier du jeu en mettant en regard
  `external_id` et les noms du dossier accordé. Mais `external_id` doit passer
  la grammaire des ids opaques : `[A-Za-z0-9._\-:]`, ≤ 256 octets
  (`plugin_manifest.rs:499`). Un placeholder s'appelle d'après un jeu :
  `Horizon Zero Dawn.stream` — espaces. Un titre peut porter `[PC]`, `:`,
  des apostrophes. Tous interdits.
- **La règle.** `external_id = "x:" + hex_minuscule(nom_complet_du_fichier)`.
  - `x:` est un **namespaces qu'aucun nom classique ne peut entrer** : l'hôte
    ne liste jamais un nom contenant `:`, donc un hex et un nom ne peuvent pas
    décrire le même fichier entre eux ;
  - **minuscule uniquement** : c'est la seule écriture canonique, et la
    référence est la clé de la carte de jeu — deux écritures = deux cartes pour
    un fichier ;
  - le préfixe et le corps sont aussi ce qui garde l'encodage
    **ordre-préservant** si un jour un curseur devait reposer dessus.
- **L'hôte sait décoder** : `runner_host::GrantedLibrary` connaît cet encodage
  (constante `HEX_REFERENCE_PREFIX = "x:"`, `runner_host.rs:77`) et **re-liste
  le dossier lui-même** pour résoudre — il ne concatène jamais ce que le guest
  dit sur un chemin.
- Longueur : 2 octets de préfixe + 2×nom ; la référence reste limitée à
  **256 octets** comme tout id opaque — l'hôte a la même borne de son côté :
  `MAX_HEX_REFERENCE_BYTES = (256 - 2) / 2` = **127 octets de nom**
  (`runner_host.rs:82`). Au-delà, l'hôte refuse la référence
  (`candidate reference`) et **toute la page échouerait** — donc le plugin
  **écarte lui-même** les noms trop longs (une seule ligne au journal pour
  prévenir, jamais un import cassé pour les autres jeux). Voir `src/lib.rs`,
  `MAX_REFERENCE_BYTES`, qui vaut exactement 127. C'est une borne réelle à
  connaître (`05-manques-et-plan.md` §8).

## 2. Chaque candidat doit être un fichier local réel

- `resolve_page_candidates` (`runner_host.rs:1445`) : pour chaque candidat,
  `GrantedLibrary::resolve(external_id)` → chemin **dedans** un dossier accordé
  et fichier régulier. Sinon : `skipped += 1`, **silencieusement**.
- Conséquence pratique : **on ne peut pas importer un jeu distant « en l'air »**.
  Un jeu qui vit sur une machine Sunshine n'a pas de fichier ici → il faut un
  placeholder local (c'est tout le principe du format `.stream`), sinon la
  carte n'apparaît jamais.
- Au lancement, le fichier est **revérifié** (`reverify_game_file`,
  `runner_host.rs:1145`) : dossier débranché / retiré = erreur avant même
  d'appeler le plugin.

## 3. Pagination : les trois façons de faire échouer un import

1. **Page plus longue que `limit`** (plafond réel `min(limit, 100)`) →
   `page longer than asked`, la page entière est rejetée
   (`plugin_runtime.rs:3457`).
2. **`(provider_id, external_id)` en double dans la page** →
   `duplicate reference` (`:3471`).
3. **`complete: true` avec un curseur** → `cursor after completion`
   (`:3503`) ; curseur hors charset/taille → `page cursor` (`:3498`).

Règles de conception qui évitent les trois :

- plafonner **ici** : `limit.min(100)`, et un `limit == 0` → page vide
  *complète* (une page vide sans curseur termine l'import ; une page vide avec
  curseur le ferait tourner) ;
- **le curseur est un index** (`usize` en décimal), pas un nom : un nom de
  255 octets hexadécimalisé = 510 octets > 256 autorisés. Même choix que
  Ryujinx (`plugins/ryujinx/src/lib.rs`, commentaire « the cursor is a
  position in that listing rather than a name »). L'index reste stable parce
  que le listing est **trié par nom par l'hôte** — on re-trie par prudence, ça
  ne coûte rien à 256 entrées ;
- si le curseur reçu n'est pas un `usize` → `plugin-error`
  `invalid-input` (« This runner did not issue that page cursor. »), pas un
  panique : un panique guest = échec d'invocation.

## 4. Le mode de lancement est fermé

`mode: "default"` **uniquement**. Toute autre chaîne →
`PluginRuntimeError::InvalidResult("intent mode")` (`plugin_runtime.rs:3543`).
Ajouter un mode (`"stream"`, `"intent"`, …) est une décision d'ABI côté Orivo :
`PluginLaunchMode` n'a qu'une variante et le `match` de
`runner_host.rs:1184` est **exhaustif volontairement**. Un plugin ne peut ni
détourner ce canal ni y mettre un argument. Voir `05-manques-et-plan.md` §3.

## 5. Budget : rester loin du plafond

- `discover-page` : 500M fuel / 5 s — **mais 256 host-calls** par invocation.
  Un listing = 1 host-call. Une page = **un seul `list-directory`**, puis filtrage
  en mémoire. Ne jamais faire un appel par entrée.
- `prepare-launch` / `validate-profile` : 50M / 1 s. Une poignée d'opérations
  suffit.
- `identity` / `health-check` : 5M / 250 ms, **sans grant** — ne jamais y
  toucher au disque.
- Le fuel est une limite *d'exécution* : un busy-loop est tué, ce qui se
  manifeste comme un plugin « qui plante » côté utilisateur. D'où : pas de
  tri O(n²) gratuit, pas d'allocation folle (64 MiB par instance).

## 6. Les slots : `"games"`

- Le nom de `grant` passé à `list-directory` est **le nom du slot** du profil,
  et l'unique slot que l'UI accorde par défaut est `games`
  (`runner_commands.rs:47`). Ce plugin ne demande rien d'autre : un utilisateur
  qui a accordé le dossier par défaut a tout accordé.
- Clé de persistance : `<profile-id>:<slot>` (`catalog.rs:3212`) — deux
  profils peuvent porter le même slot sans se marcher dessus ; révoquer l'un
  ne touche pas l'autre.
- ≤ 32 dossiers par profil (`catalog.rs:3040`), donc un plugin qui
  « détecterait » en scannant plusieurs dossiers doit savoir que l'UI, aujourd'hui,
  n'accorde que le slot par défaut.

## 7. Identité et version : trois endroits, une seule vérité

`package/manifest.json` `version` = `Cargo.toml` `version` =
`get_identity().version` (`src/lib.rs`, constante `PLUGIN_VERSION`). Le
pré-install gate les compare et refuse un paquet en désaccord. Chaque rebuild
qui touche une version doit rebuild **et** redéposer le digest.

## 8. Le build est un produit reproductible, pas une habitude

`build.sh` (modèle : `plugins/ryujinx/build.sh`) :

1. **toolchain pinnée** par `rust-toolchain.toml` (`1.98.1`) — le script
   **refuse** de builder avec un autre `rustc` : un `stable` flottant changerait
   le digest six semaines plus tard sans changement de source ;
2. **`wasm-tools` version vérifiée** (`1.246.2`) : l'encodage du composant doit
   correspondre à la Wasmtime de l'hôte, sinon le digest diffère ;
3. **`rust-src` présent** : l'artefact change d'une quarantaine de octets selon
   que les sources std sont installées (chemins absolus vs préfixe
   `/rustc/<commit>`) ;
4. **remap des chemins** (`--remap-path-prefix`) : toolchain, registry cargo,
   ce dépôt → le fichier ne porte le chemin du dossier de personne (vérifié par
   `grep $HOME` sur la sortie) ;
5. strip de `producers` + `component-type.*`, `wasm-tools validate`, puis
   **digest + taille imprimés** — les deux valeurs à coller dans
   `package/manifest.json`.

## 9. La boucle de validation (à exécuter avant chaque commit)

```sh
# dans ce dépôt :
./build.sh                                    # → digest + taille

# via le SDK Orivo (depuis ~/repos/orivo) :
cargo run --manifest-path sdk/orivo-plugin-sdk/Cargo.toml -- validate <dir>
cargo run --manifest-path sdk/orivo-plugin-sdk/Cargo.toml -- check <dir>
cargo run --manifest-path sdk/orivo-plugin-sdk/Cargo.toml -- simulate <dir> \
  --request discover-page --grant games=<dossier-de-test> --limit 20
```

- `validate` : manifeste + paquet complet. **Le paquet exige une
  `signature.ed25519`** (`plugin_manifest.rs:460-463` : `Missing` = erreur) —
  Orivo lui-même n'en commite pas dans `plugins/ryujinx/package/` ; le test du
  SDK en fabrique une « dev » dans une copie temporaire. Faire pareil :
  copie temp + `printf dev > signature.ed25519`. (À l'installation réelle, le
  fichier `.orivo-plugin` passe par le canal dev `AllowUnsigned` — la signature
  sert à la validation du *paquet*, pas au téléchargement.)
- `check` : contrat du composant (`ComponentContract { required_capabilities:
  {FilesRead} }`) + `get-identity`/`health-check` — exactement la porte
  pré-install du registre.
- `simulate` : une vraie invocation dans la vraie runtime, vrais budgets, vrais
  grants (`--grant games=...`). **C'est la seule preuve qui compte.**
  Rapporter aussi le journal host : un refus (`capability-refused`,
  `scope-refused`, `files-truncated`) s'y lit, jamais dans la réponse.

## 10. La liste noire

- **WASI** (horloge, aléatoire, socket, pré-ouverture) → refusé avant
  instanciation.
- **Écrire** : aucune écriture n'existe. Jamais.
- **Un script ou binaire dans le package** → `forbidden native binary or script`.
- **Un chemin, une commande, un argument** dans l'intent → impossible par
  construction ; tenter de le cacher dans `mode` → rejet.
- **Se déclarer `installer`** → slot mono-instance déjà pris, et l'implémentation
  hôte est celle de Quiky (`05-manques-et-plan.md` §5).
- **Déclarer `network_domains` sans `network_fetch`** (et inversement) →
  manifeste invalide ; et dans les deux cas, **le guest n'aura toujours pas de
  réseau**.
- **Un id ou une référence hors charset / > 256 octets** → `candidate
  reference`, page entière rejetée.
- **Se fier à un listing > 256 entrées** → la queue est invisible, sans erreur.
- **Inventer des candidats** qui ne correspondent à aucun fichier → skippés en
  silence : l'import « réussit » et la bibliothèque reste vide.
