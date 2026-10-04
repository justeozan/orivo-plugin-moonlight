# 02 — L'interface de communication : le contrat `orivo-plugin@1` vu par un auteur

Le contrat vit dans `wit/orivo-plugin.wit` — dans ce dépôt, **une copie
octet-à-octet** de celle d'Orivo (`wit/README.md` donne la commande de
vérification). Ce document le décrit opération par opération, tel que
l'hôte l'implémente réellement (`src-tauri/src/plugin_runtime.rs`), pas tel que
le WIT le laisse rêver.

## 1. Le monde que nous utilisons

```wit
world runner-plugin {
  import host-journal;   // journal de diagnostic
  import host-files;     // lecture de dossiers accordés
  export plugin-core;    // get-identity, health-check
  export runner;         // validate-profile, discover-page, prepare-launch
}
```

Tout ce qui n'est ni importé (linké) ni exporté (appelé) n'existe pas. Un
composant qui référence un import absent du linker **échoue à l'instanciation**,
avant toute instruction.

## 2. `plugin-core` — qui es-tu ?

### `get-identity() -> identity`
- Budget **probe** (5M fuel / 250 ms), **aucun grant** à cet instant.
- `id` et `version` doivent être des ids opaques valides (≤ 256 octets,
  `[A-Za-z0-9._\-:]`) et **doivent être égaux au manifeste** : le registre
  refuse un paquet qui se contredit (`RunnerCheck`, `check` du SDK).
- `extensions` : ici `[runner]`.

### `health-check() -> result<health, plugin-error>`
- Même budget probe, mêmes grants (aucun). **Ne pas y toucher les dossiers** :
  ce n'est ni le lieu ni le budget.
- `ready` + message optionnel (≤ 512 octets). Un `ready: false` ou un échec
  compte dans les 3 échecs consécutifs avant mise au park du plugin
  (`plugin_runtime.rs:170`).

## 3. `runner` — les trois opérations

### `validate-profile(profile: {id, display-name})`
- Budget **interactif** (50M / 1 s).
- Le guest ne reçoit **que** ces deux champs — pas le dossier, pas l'OS, pas
  l'application.
- **Mais les grants du profil sont déjà résolus** pour cet appel
  (`runner_host.rs:638-647`) : `list-directory("games")` répond par un listing
  ou par `permission-denied`. Au premier appel d'un profil neuf, aucun dossier
  n'est accordé → la lecture échoue, donc un plugin ne peut pas promettre de
  « détecter » quoi que ce soit ici.
- Réponse : `valid` + `message` (≤ 512). `valid: false` → le profil passe en
  statut `Rejected` avec le message, **le profil et ses dossiers sont conservés**
  (`apply_profile_validation`, `runner_host.rs:659`).
- Une erreur (`plugin-error`) ≠ `valid: false` : elle fait échouer l'appel
  hôte. Réserver `valid: false` à un refus propre.

### `discover-page(profile-id, request: {cursor, limit})`
- Budget **discovery** (500M / 5 s) — le plus généreux, mais pas une
  invitation à scanner : 256 host-calls max par invocation.
- `limit` : le plafond réel est `min(limit, 100)` ; **renvoyer plus est une
  erreur qui annule toute la page** (`plugin_runtime.rs:3457-3460`,
  « page longer than asked »).
- `cursor` : opaque, **≤ 256 octets**, même charset que les ids. C'est un
  détail **privé au plugin** : l'hôte le renvoie tel quel. Deux pièges de conception :
  un nom de fichier (255 octets) hexadécimalisé = 510 octets → **le nom ne peut
  pas être le curseur** ; et `complete: true` **avec** un curseur = erreur
  (`:3503-3505`). Ryujinx et ce plugin utilisent donc un **index** dans le
  listing trié (voir `03-regles-de-construction.md`).
- Chaque candidat :
  - `reference.provider_id` / `external_id` : ids opaques (≤ 256) —
    d'où l'encodage `x:` + hex ;
  - doublon `(provider_id, external_id)` **dans la page** = erreur (`:3471`) ;
  - `title` ≤ 512, `sort-title`/`platform` optionnels ≤ 512 ;
  - `installed` : booléen pur.
- Ce que l'hôte fait ensuite (`resolve_page_candidates`,
  `runner_host.rs:1445`) : **il liste le dossier accordé lui-même** et
  associe chaque `external_id` au fichier correspondant. Un candidat qui ne
  correspond à aucun fichier est **skippé silencieusement** (`skipped`),
  sans erreur — un plugin qui invente des titres ne fait qu'écrire du vide.
- L'import est paginé, transactionnel et reprenable ; le catalogue n'est écrit
  qu'entre deux pages (`runner_host.rs` commentaires autour de `:1480`).

### `prepare-launch(profile-id, game-reference) -> launch-intent`
- Budget **interactif** (50M / 1 s).
- L'intent ne contient que `{runner-id, profile-id, game-reference, mode}` :
  **aucun chemin, aucun argument, aucun répertoire courant**.
- L'hôte exige que les trois ids soient **identiques** à ceux de l'appel
  (`runner_host.rs:1175-1182`) — l'écho n'est pas une formalité, c'est le
  contrôle.
- `mode` est une chaîne… que l'hôte traduit dans un **enum fermé** :
  `"default"` → `PluginLaunchMode::Default`, **toute autre valeur = erreur**
  (`plugin_runtime.rs:3541-3544`). Il n'existe pas de autre mode en v1.
- Le fichier de jeu et l'application sont résolus **avant/après** cet appel par
  l'hôte lui-même ; le plugin ne fait que « donner son accord » et restituer le
  trio. Voir `01-contexte-orivo.md` §8 pour l'ordre exact.

## 4. `host-files` — la seule porte sur le disque

### `list-directory(grant) -> list<{name, byte-size, directory}>`
- `grant` = **le nom du slot** (`"games"`), pas un chemin. L'hôte ne connaît
  que `<profil>:<slot>` → descripteur ouvert (`O_NOFOLLOW`), re-résolu à
  chaque usage.
- **Non récursif** ; **les symlinks sont omis**, pas résolus.
- Tri par nom, **tronqué à 256 entrées** (le scan s'arrête à 4096) ; si
  troncature, l'hôte le note au journal (`files-truncated`, `:1896-1912`) — le
  guest, lui, ne peut pas le savoir. **Un dossier de plus de 256 entrées a une
  queue invisible.**
- Jamais de chemin, jamais de « .. », jamais d'absolu.

### `read-file(grant, name) -> list<u8>`
- `name` = **un composant simple** : pas de `/`, pas de `.`, pas de `..`, pas
  de `:` (un préfixe de lecteur Windows détruirait le grant), pas de caractères
  de contrôle (`plugin_runtime.rs`, `valid_entry_name`).
- Fichier régulier uniquement, sans suivi de symlink, **≤ 1 MiB** ;
  **8 MiB de lecture cumulés par invocation** (une invocations ne peut pas
  vider un dossier dans sa mémoire linéaire).
- `name` n'a pas besoin de venir de `list-directory`, mais doit survivre à tout
  ce qui précède.

**Ce plugin n'utilise pas `read-file`** : en v0.1, un placeholder n'est qu'un
nom. Moins de capacité = moins de surface, et le compteur `bytes_read` du
runtime en est la preuve observable.

## 5. `host-journal` — pas une capacité, mais compté

- `log(level, message)` : message ≤ 512 octets, journal de 256 entrées,
  4096 octets facturés par host-call.
- Rien n'atteint l'utilisateur tel quel ; tout reste dans le diagnostic hôte.
- C'est ici qu'on note un refus de grant (voir `src/lib.rs`) : « a refused
  grant is only auditable when the attempt is recorded beside it ».

## 6. Le tableau complet : ce que le contrat sait / ne sait pas

| Besoin Moonlight/Sunshine | Dans le contrat v1 ? | Où il faudra le faire |
|---|---|---|
| Lister une bibliothèque locale | ✅ `list-directory` | le plugin |
| Préparer un lancement | ✅ `prepare-launch` (modes `default` et `stream`) | le plugin nomme le mode, l'hôte construit le process |
| Lire des métadonnées locale (ex. `apps.json` de Sunshine) | ✅ `read-file` (≤ 1 MiB) | le plugin |
| Parler au réseau (API Sunshine, pairage, LAN) | ❌ **aucun import** | révision de contrat / hôte Orivo |
| Savoir l'OS du guest | ❌ **jamais transmis** | révision de contrat / détection hôte |
| Lancer `moonlight stream <hôte> <jeu>` (2 args) | ✅ mode `stream` : l'hôte construit la liste fermée | l'hôte, depuis le placeholder qu'il a écrit |
| Lancer Moonlight/SSH sans fichier local | ❌ le fichier doit exister dans un grant | inchangé — le placeholder *est* ce fichier |
| Proposer une installation (UI, modale, bouton) | ❌ `ui-plugin` contract-only | Orivo lui-même |
| Exécuter `moonlight list`, contrôler un processus | ❌ pas d'exécution | Orivo / futur |
| Horloge, aléatoire, WASI | ❌ refusé avant instanciation | — |

## 7. Le trajet d'une requête, en une phrase

Hôte (budget en main) → traduction WIT → guest → réponse → **validation stricte
par l'hôte** (formats, tailles, charset, cohérence avec la requête, résolution
réelle sur disque) → seulement alors publication dans le catalogue ou
construction d'un processus. Une réponse invalide = erreur d'invocation, pas une
dégradation silencieuse — sauf, précisément, un candidat qui ne résout pas en
fichier : lui est skippé.
