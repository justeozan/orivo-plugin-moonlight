# orivo-plugin-moonlight

Le contexte complet d'Orivo et le squelette du plugin **Moonlight / Sunshine**
(`com.orivo.gamestream`) pour le système de plugins d'Orivo : ce qui est déjà
possible, ce qui ne l'est pas, et pourquoi — avec un composant WebAssembly qui
compile, se valide et se simule aujourd'hui.

> **État honnête** : la Phase 0 est livrée (documentation + squelette validé).
> Un clic **Play** ne streamme pas encore par lui-même : le contrat d'Orivo ne
> donne qu'**un seul argument** au lancement (`un fichier`), alors que Moonlight
> exige `stream <hôte> <jeu>`, et le guest n'a **aucun accès réseau** pour
> lire une bibliothèque distante. La parade du v0.1 est un *wrapper* choisi
> comme application du profil ; le vrai fix est une décision d'ABI côté Orivo.
> Tout est détaillé dans [`docs/05-manques-et-plan.md`](docs/05-manques-et-plan.md).

## Ce qu'il y a ici

```
├── README.md                     ← ce fichier
├── docs/
│   ├── 01-contexte-orivo.md      ← comment Orivo fonctionne VRAIMENT (vérifié, fichier:ligne)
│   ├── 02-interface-de-communication.md ← le contrat orivo-plugin@1 opération par opération
│   ├── 03-regles-de-construction.md     ← ce qui fait échouer un plugin, et comment s'y prendre
│   ├── 04-specification-plugin.md       ← le plugin : besoins → mappage, format .stream, matrice
│   └── 05-manques-et-plan.md            ← les manques du contrat + le plan en phases
├── wit/
│   ├── orivo-plugin.wit          ← copie OCTET-À-OCTET du contrat gelé d'Orivo
│   └── README.md                 ← provenance (commit db03c6c) et comment re-synchroniser
├── src/lib.rs                    ← le composant (world runner-plugin)
├── Cargo.toml / rust-toolchain.toml / build.sh   ← build reproductible, digest pinné
├── manifest.json.example         ← la forme du manifeste avant build
├── package/
│   ├── manifest.json             ← manifeste réel (sha256 + taille du composant)
│   └── component.wasm            ← artefact committé, digest vérifié à chaque validate
└── fixtures/stream-library/      ← dossiers de test : espaces, crochets, .txt ignoré, nom trop long
```

## La boucle de build (dans ce dépôt)

Prérequis : `rustup`, `rustup target add wasm32-unknown-unknown`,
`rustup component add rust-src`, et `cargo install wasm-tools --locked --version 1.246.2`.

```sh
./build.sh        # compile, valide le composant, affiche sha256 + taille
```

Si le code change : coller les deux valeurs dans `package/manifest.json`
(`artifacts[0].sha256` / `byteSize`), sinon `validate` échoue — c'est voulu.

## La boucle de validation (depuis le dépôt Orivo)

```sh
cd ~/repos/orivo
SDK="sdk/orivo-plugin-sdk/Cargo.toml"
PKG=/Users/spectre/repos/orivo-plugin-moonlight/package

# validate exige une signature "dev" à côté du manifeste (copie temporaire) :
rm -rf /tmp/gs && mkdir /tmp/gs && cp $PKG/* /tmp/gs/ && printf dev > /tmp/gs/signature.ed25519
cargo run --manifest-path $SDK -- validate /tmp/gs
cargo run --manifest-path $SDK -- check   /tmp/gs

# une vraie invocation, vrais budgets, vrais grants :
cargo run --manifest-path $SDK -- simulate /tmp/gs \
  --request discover-page --grant games=/Users/spectre/repos/orivo-plugin-moonlight/fixtures/stream-library \
  --limit 20
cargo run --manifest-path $SDK -- simulate /tmp/gs \
  --request prepare-launch --profile-id moonlight-main \
  --game-reference x:486f72697a6f6e205a65726f204461776e2e73747265616d \
  --grant games=/Users/spectre/repos/orivo-plugin-moonlight/fixtures/stream-library
```

Attendu : `validate`/`check` en `OK`, `discover-page` qui rend `Celeste [PC]`,
`Horizon Zero Dawn` et `魔女の旅々` (les `.txt` ignorés, le nom de 140
caractères écarté avec une ligne d'avertissement au journal),
`prepare-launch` qui rend `LaunchIntent { … mode: Default }`. Sans `--grant`,
la simulation doit **échouer** avec `capability-refused: files_read is not
granted` — c'est le garde-fou qui marche.

## Les cinq documents, dans l'ordre

1. [`docs/01-contexte-orivo.md`](docs/01-contexte-orivo.md) — la plateforme :
   monde `runner-plugin` seul invocable, deux imports hôte (fichiers + journal),
   **pas de réseau, pas d'OS, pas d'UI**, budgets, pipeline de lancement à un
   argument. Tout y est référencé `fichier:ligne` sur Orivo `db03c6c`.
2. [`docs/02-interface-de-communication.md`](docs/02-interface-de-communication.md) —
   le contrat, appel par appel, avec les erreurs réelles qu'il produit.
3. [`docs/03-regles-de-construction.md`](docs/03-regles-de-construction.md) —
   encodage `x:`+hex, résolution obligatoire en fichier local, pagination,
   mode fermé, budget, build reproductible, boucle SDK, liste noire.
4. [`docs/04-specification-plugin.md`](docs/04-specification-plugin.md) — le
   plugin : mappage des besoins, modèle (profil = client, dossier =
   placeholders `.stream`), matrice d'installation, Play + doublons.
5. [`docs/05-manques-et-plan.md`](docs/05-manques-et-plan.md) — les sept manques
   structurels et le plan en 4 phases.

## Installer le plugin dans Orivo (canal dev)

Empaqueter `package/` (manifeste + composant) en **tar gzippé** nommé
`*.orivo-plugin`, puis `Settings → Plugins → install from file`
(`install_plugin_from_file`, non signé accepté, installé en développement).
Ensuite : création de profil runner → « Add a folder » (slot `games`) →
import → bibliothèque. Ryujinx (`orivo/plugins/ryujinx/`) est le plugin de
référence du même gabarit.

## Conventions de ce dépôt

- docs en **français** (conventions du dépôt Orivo) ; commentaires de code en
  **anglais** (conventions du code Orivo) ;
- `wit/orivo-plugin.wit` ne se modifie **jamais** : on re-copie depuis Orivo
  (`wit/README.md`) ;
- Aucune dépendance à un chemin absolu d'Orivo hors des commandes de validation
  documentées ci-dessus.
