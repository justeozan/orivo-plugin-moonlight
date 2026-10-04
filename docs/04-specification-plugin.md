# 04 — Spécification : `com.orivo.gamestream`, le runner Moonlight / Sunshine

## 1. Les besoins, et leur place exacte

Besoins exprimés : (1) détecter les clients installés, (2) proposer une
installation selon la plateforme, (3) synchroniser les jeux locaux et distants,
(4) un bouton **Play** qui lance Moonlight directement sur le bon jeu,
(5) une modale quand un jeu existe à la fois en local et à distance.

| # | Besoin | Dans le contrat v1 ? | Où ça vit vraiment |
|---|---|---|---|
| 1 | Détecter les clients installés | Partiellement (lecture de dossiers accordés, sans savoir l'OS) | plugin (lecture) + **Orivo** (UI, parcours de grant) |
| 2 | Proposer l'installation par plateforme | ❌ pas d'OS transmis, `ui-plugin` contract-only | **Orivo** (futur) |
| 3 | Synchro des jeux locaux/distant | ✅ par l'hôte : il interroge l'API Sunshine et écrit les placeholders | **Orivo** (`gamestream.rs`) ; le guest n'aura jamais de réseau |
| 4 | Play → Moonlight sur le bon jeu | ✅ mode `stream` : `stream <hôte> <jeu>`, liste construite par l'hôte | **Orivo** (le mode) + ce plugin (il le nomme, `v0.2.0`) |
| 5 | Modale de doublon local/distant | ❌ UI | **Orivo** (la clé de carte rend le doublon détectable) |

Rien de tout cela n'est un détail d'implémentation : ce tableau est la
cartographie honnête du projet. Les sections suivantes décrivent ce qui
**tourne aujourd'hui** et ce qui suppose des évolutions Orivo
(`05-manques-et-plan.md`).

## 2. Le modèle mental

```
Profil runner « Moonlight (Windows) »
 ├── application   = chemin choisi par l'utilisateur (moonlight.exe, ou un wrapper)
 ├── grant slot    = "games"  → un dossier de SON CHOIX sur son disque
 │                    └── un fichier par jeu streamable : « Mon Jeu.stream »
 └── validate-profile / discover-page / prepare-launch → com.orivo.gamestream
```

- **Un profil = un client** (ou une configuration de client). Rien n'oblige à
  n'en avoir qu'un : deux profils = deux cartes distinctes par construction
  (clé `runner_game_id`, `runner_host.rs:1592`).
- **Le dossier accordé = la bibliothèque de placeholders.** Ce n'est pas le
  dossier d'installation de Moonlight, ni le dossier de Sunshine. C'est un
  endroit où l'utilisateur (ou un futur outil Orivo) dépose **un fichier par
  jeu auquel il veut pouvoir lancer un stream**.
- **Le fichier de jeu doit exister localement** : c'est la façon, dans le
  contrat v1, de représenter un jeu qui vit sur une autre machine. Sans
  fichier, `resolve_page_candidates` skippe le candidat en silence
  (`03-regles-de-construction.md` §2).

## 3. La matrice d'installation voulue

| Plateforme | Clients à proposer |
|---|---|
| Windows | Moonlight, Sunshine, Apollo, Artemis |
| macOS | Moonlight |
| Linux | Moonlight, Sunshine |
| Android | Artemis, Sunshine |
| iOS | Moonlight |

**Le guest ne peut pas appliquer cette matrice** : il ne sait pas sur quel OS
il tourne (`01-contexte-orivo.md` §4). Deux façons honnêtes de la servir, toutes
deux côté Orivo :

1. **Par profil** : l'utilisateur crée le profil *pour* sa plateforme (le nom
   du profil le porte déjà : « Sunshine (Windows) »), et l'UI d'Orivo — elle,
   elle connaît l'OS — affiche la bonne matrice dans le parcours
   « Add a runner » ;
2. **Par contrat futur** : exposer l'OS au guest (nouvel import hôte ou champ
   transmis à `validate-profile`), après quoi le plugin peut lui-même répondre
   « ce dossier ne contient aucun client connu : voici ce qui convient à cette
   machine ». C'est une révision d'ABI, pas un réglage (`05-manques-et-plan.md` §2).

Le skeleton ne fait **aucune** des deux : il expose le socle sur lequel l'une ou
l'autre s'appuiera.

## 4. Détection des clients installés — ce qui est faisable

Dans le contrat v1, « détecter » = `list-directory` sur un dossier accordé et
reconnaître des noms :

- macOS : `/Applications` accordé → `Moonlight.app` (entrée `directory: true`) ;
- Windows : `C:\Program Files` accordé → `Moonlight`, `Sunshine` ;
- Linux : `/usr/bin`, `/usr/share/applications`, un dossier de Binaires…

Contraintes réelles :

- **l'UI n'accorde aujourd'hui que le slot `games`** ; demander un second slot
  (`clients`) suppose que le parcours Orivo l'offre — le contrat le permet
  (32 dossiers max), l'application ne l'expose pas encore ;
- `list-directory` n'est **pas récursif** : un dossier qui contient les clients
  *et* leur sous-structure ne se lit qu'à plat ;
- la **détection n'a aucune surface d'affichage** : sans `ui-plugin`, le seul
  endroit où l'un quelque chose serait `validate-profile` → statut/`message` du
  profil (`Rejected` + phrase), ou le journal. Présenter un choix
  d'installation exige le côté Orivo.

État du squelette : `validate-profile` ne touche volontairement pas au dossier
(premier appel = aucun grant, et un refus ne doit pas rejeter un profil qui
n'a encore rien à valider — commentaire dans `src/lib.rs`).

## 5. Le format `.stream`

- **Nom** : `<Titre>.stream`. Le nom *est* le titre ; l'`external_id` en dérive
  (`x:` + hex, `03-regles-de-construction.md` §1).
- **Corps** : **lu, depuis le mode `stream`** (§3.2 de `05`). Le plugin ne le
  lit jamais — il n'a pas `read-file` — mais l'hôte, lui, l'écrit et le relit
  au lancement pour en tirer `<hôte>` et `<jeu>` :

```json
{ "host": "astra.local", "client": "moonlight", "app": "Celeste" }
```

  L'hôte revalide ces trois champs à chaque lancement plutôt que de faire
  confiance à ce qu'il a écrit : un fichier posé là par autre chose que le feed
  doit encore être ce document pour pouvoir lancer quoi que ce soit. `client`
  doit valoir `moonlight` ; `host` et `app` sont bornés, sans caractères de
  contrôle, et ne peuvent pas commencer par `-`.

- **Pourquoi une extension inconnue du système** : elle ne doit être ouverte
  par rien, associée à rien, ni bloquée par des filtres de type. Un simple
  fichier texte suffit (voir `fixtures/stream-library/`).
- **Portée** : un fichier = un jeu **de ce profil**. Deux profils avec le même
  jeu = deux fichiers = deux cartes — c'est le cas « local + distant » que la
  modale devra offrir côté Orivo (§7).

## 6. Synchro locale / distante (l'état réel)

- **Locale** : fonctionne. Un jeu installé sur la machine = un fichier placeholder,
  listé, importé, lancé.
- **Distante (Sunshine sur une autre machine)** : **pas de réseau dans le
  guest**. Impossible de : découvrir les hôtes, interroger l'API Sunshine
  (`/api/apps`), appeler `moonlight list <hôte>`, ou pairer.
- **Hybride acceptable en v0.1** : l'utilisateur (ou un futur script hôte)
  maintient la liste des jeux distants dans son dossier `games` ; le plugin se
  contente de les présenter. La « synchro » est alors manuelle, et c'est
  assumé : voir `05-manques-et-plan.md` §1 pour la trajectoire vers du vrai.

## 7. Play, et la modale de doublon

### Le bouton Play aujourd'hui
Orivo affiche déjà les cartes runner avec leur Play (`src/app.ts`, ligne
« COMING SOON » pour Moonlight/Sunshine, `:2425`). Le clic appelle `launch_game`
→ `prepare_runner_launch` → `application + [fichier]`.

**Ce qui manquait, et ne manque plus** : `moonlight stream <hôte> <jeu>` exige
deux arguments, et le contrat v1 n'en donnait qu'un. C'est la deuxième issue
ci-dessous qui a été retenue et livrée, côté Orivo ; la première est conservée
ici pour mémoire, parce que c'est elle qui explique pourquoi le corps du
`.stream` a la forme qu'il a. Un profil en mode `stream` pointe maintenant
directement sur le binaire Moonlight.

1. ~~**Wrapper (workaround, sans toucher à Orivo)**~~ — plus nécessaire :
   l'utilisateur choisissait comme *application* du profil un exécutable qui
   accepte un fichier et fait le reste — sur macOS/Linux un script
   `moonlight-stream` :

   ```sh
   #!/bin/sh
   # $1 = le placeholder, ex. "~/Games/stream/Horizon Zero Dawn.stream"
   # (v0.1 : le nom porte le titre ; le corps portera host/app en v2)
   exec moonlight stream living-room-pc "Steam"
   ```

   `resolve_application` exige un fichier **exécutable** (`runner_host.rs:1063`)
   → `chmod +x`. Sur Windows : il faut un petit `.exe` helper (un `.bat` n'est
   pas lancé par `Command::new`), donc un binaire **hors** du package — c'est
   une borne documentée, pas une solution livrée.
2. **Vrai fix** : un second mode de lancement côté Orivo (§3 de
   `05-manques-et-plan.md`).

### La modale de doublon
Deux profils = deux `runner_game_id` = deux cartes **même titre**. Le doublon
est donc parfaitement détectable côté Orivo (titre + profils différents, ou
même `game_ref` sous deux profils). La modale (« Lancer la version locale /
lancer le stream distant / ne plus me proposer ») est une **UI Orivo** : le
plugin ne peut pas la déclencher ni la rendre. Il faut la compter dans le
périmètre « travail hôte » du plan (§Phase 3 de `05`).

## 8. Le squelette livré (`src/lib.rs`)

| Export | Comportement |
|---|---|
| `get-identity` | `com.orivo.gamestream` `0.1.0`, `[runner]` |
| `health-check` | `ready: true`, aucun accès disque |
| `validate-profile` | refuse un id vide ; **ne lit aucun dossier** |
| `discover-page` | liste `*.stream` du slot `games`, trie, écarte les noms > 127 octets (journal), pagine par index, `x:`+hex, `installed: true` |
| `prepare-launch` | écho strict des trois ids, `mode: "default"` |
| `read-file` | **non utilisé** (surface minimale) |
| grant | `games` uniquement |

Manifeste : `package/manifest.json` (`runner` + `runner_prepare`,
`files_read`, aucun domaine réseau), artefact `component.wasm` (digest dans le
manifeste). `manifest.json.example` montre la forme avant build.

### Tester, sans installer Orivo

```sh
./build.sh
# validate/check/simulate via le SDK (voir 03-regles-de-construction.md §9), ex. :
cargo run --manifest-path ~/repos/orivo/sdk/orivo-plugin-sdk/Cargo.toml -- \
  simulate package --request discover-page --grant games=fixtures/stream-library --limit 20
```

Les fixtures couvrent : titre avec espaces, titre avec crochets, titre CJK
(octets multi-octets encodés en hex), fichiers ignorés (`.txt`), nom trop long
(avertissement au journal).

### Installer dans Orivo (canal dev)

`Settings → Plugins → install from file`, avec un fichier `.orivo-plugin`
(**tar gzippé** contenant `manifest.json` + `component.wasm`, au plus) :
`install_plugin_from_file` accepte le non-signé et l'installe en développement
(`plugin_installer.rs:472`). Le plugin apparaît ensuite dans la création de
profil runner, exactement comme Ryujinx.
