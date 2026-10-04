# orivo-plugin-moonlight

Le contexte complet d'Orivo et le squelette du plugin **Moonlight / Sunshine**
(`com.orivo.gamestream`) pour le système de plugins d'Orivo : ce qui est déjà
possible, ce qui ne l'est pas, et pourquoi — avec un composant WebAssembly qui
compile, se valide et se simule aujourd'hui.

> **État honnête** : un clic **Play** streamme, à partir de `v0.2.0` sur un
> Orivo `0.3.7`. Les deux
> manques qui l'en empêchaient ont été fermés **côté hôte**, et c'est là qu'ils
> devaient l'être : Orivo a maintenant un mode de lancement `stream` dont il
> construit lui-même la liste d'arguments `stream <hôte> <jeu>` à partir du
> placeholder (`05-manques-et-plan.md` §3.2), et c'est Orivo qui interroge
> l'API Sunshine et **écrit** les placeholders dans le dossier accordé (§1.2).
> Le *wrapper* du v0.1 n'est donc plus nécessaire : l'application du profil est
> le binaire Moonlight. Le guest, lui, n'a toujours aucun accès réseau et n'en
> aura pas : c'est le point, pas une lacune.
>
> Ce que ça exige en retour : un Orivo qui connaît le mot `stream`. Le mode
> ship dans **0.3.7**, donc c'est le `minOrivoVersion` de `v0.2.1`. Un hôte
> plus ancien refuse maintenant le paquet **à l'installation** — là où une
> exigence de version doit être refusée — plutôt qu'au premier Play avec
> `invalid-result("intent mode")`, qui accusait le plugin d'un défaut de
> l'hôte. `v0.2.0` déclarait `0.3.0` faute de numéro ; c'est corrigé. Voir
> [`orivo/docs/gamestream.md`](../orivo/docs/gamestream.md).
>
> **Publication** : `v0.1.0` est empaquetée, signée avec la clé de release
> d'Orivo, publiée en release GitHub et listée dans l'index signé du registre.
> `v0.2.1` est empaquetée et signée ici ; elle n'est pas encore publiée.

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
├── scripts/                      ← empaquetage : build.mjs, sign.mjs, verify.mjs
│   └── lib/                      ← miroirs JS des règles host (manifeste, tar)
├── package.json                  ← `npm run build` / `sign` / `verify` (node ≥ 20)
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

Après `node scripts/build.mjs && node scripts/sign.mjs`, la même boucle
tourne sur `dist/stage` directement : l'archive est signée pour de bon, plus
besoin de copie temporaire ni de signature « dev ».

## Empaqueter et signer

```sh
node scripts/build.mjs     # stage package/, vérifie les digestes, packe dist/
node scripts/sign.mjs      # Ed25519 sur sha256(manifest.json) -> signature.ed25519
node scripts/verify.mjs    # re-vérifie l'archive comme Orivo le fera
```

Le résultat est `dist/com.orivo.gamestream-0.1.0.orivo-plugin` (tar gzippé :
`manifest.json`, `component.wasm`, `signature.ed25519`). La clé de release
d'Orivo vit dans `keys/` (**gitignorée, jamais committée**) ; `sign.mjs
--key <pem>` en prend une autre. `scripts/lib/manifest-rules.mjs` reproduit
les règles de `plugin_manifest.rs` : une archive refusée par le host échoue
ici, à l'emballage, avec un message lisible.

## Publier une version (registre d'Orivo)

Le Store de plugins (`Settings → Plugins`) lit l'index signé de
[`justeozan/orivo-plugin-registry`](https://github.com/justeozan/orivo-plugin-registry)
— la liste compilée dans le binaire ne contient que Quiky. Publier, c'est
donc trois choses :

```sh
# 1. l'archive publiée = l'URL de téléchargement (hôte de l'allowlist) :
shasum -a 256 dist/*.orivo-plugin && stat -f%z dist/*.orivo-plugin
gh release create v<X.Y.Z> dist/*.orivo-plugin --notes "..."

# 2. l'index — depuis le dépôt du registre (pas celui-ci) :
#    entrer sha256 + sizeBytes réels de l'archive, monter `sequence`
#    (jamais reculer), repousser `expiresAtEpochMs`, puis :
cd ~/path/to/orivo-plugin-registry
node scripts/sign.mjs && node scripts/verify.mjs
git add index.v1.json && git commit -m "index: ..." && git push

# 3. les clients ne rechargent l'index qu'à la TTL (6 h) : relancer Orivo
#    (ou attendre) force le rafraîchissement.
```

Vérifié de bout en bout pour `v0.1.0` : `parse_signed_index_with_key` (code
host réel, clé compilée) accepte l'index publié, et l'archive téléchargée
passe `install_package(.., ReleaseOnly)` — identité + health-check compris —
et apparaît comme *trusted*.

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

## Installer le plugin dans Orivo

**Canal registre** (développement public) : `Settings → Plugins` →
Moonlight / Sunshine → installer — le host télécharge l'archive de la release
via l'index signé, la vérifie contre la clé de release et l'installe en
*trusted*.

**Canal dev** : `node scripts/build.mjs && node scripts/sign.mjs` puis
`Settings → Plugins → install from file` sur `dist/*.orivo-plugin`
(installé en développement, mise à jour manuelle seule).
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
