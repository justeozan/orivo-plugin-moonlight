//! `com.orivo.gamestream` — the Moonlight / Sunshine (GameStream) runner for
//! Orivo, written against the frozen `orivo-plugin@1` contract in `wit/`.
//!
//! ## What this component is, and what it deliberately is not
//!
//! It is a `runner-plugin` over **one directory grant** (`games`, Orivo's
//! `DEFAULT_DIRECTORY_SLOT`). Inside that folder live *placeholder files* —
//! one ordinary file per streamable game, named `Some Game.stream`. Orivo
//! writes them itself from the Sunshine host's application feed when one is
//! configured (`orivo/src-tauri/src/gamestream.rs`), and the user may also
//! keep their own by hand; either way they are just names to this component.
//! It lists those files, turns each into an opaque library candidate, and
//! prepares a launch intent that echoes back exactly what the host asked
//! about. Orivo resolves the profile's application (the Moonlight binary) and
//! the placeholder file itself, and re-reads the placeholder to build the
//! arguments; this component never sees a path, never builds a command line
//! and never learns the machine it runs on.
//!
//! It is deliberately unable to: no network (there is no network import in v1),
//! no Moonlight/Sunshine process control, no OS detection (the guest is not
//! told which platform it runs on), no `read-file` — a placeholder is a file
//! *name*, so the listing is the whole library. See `docs/04-specification-plugin.md`
//! for the design and `docs/05-manques-et-plan.md` for the gaps this contract
//! cannot close yet.
//!
//! ## Why a file name is hex
//!
//! The host resolves the game file itself by matching the opaque external
//! reference this component returns against the names it finds in the granted
//! folder. That reference has to pass the catalogue's opaque-id grammar
//! (`[A-Za-z0-9._\-:]`, `plugin_manifest::valid_opaque_id`), and a placeholder
//! is conventionally named after a game title — spaces and punctuation, neither
//! of which the grammar allows. So a reference here is `x:` followed by the
//! entry name in **lower-case hexadecimal**: grammar-safe, and one spelling per
//! file. `x:` is a namespace no plain name can enter (the host never lists a
//! name containing `:`), and lower case is the single canonical spelling — a
//! reference is the key of a library card, so a second spelling would be a
//! second card for one file. Same encoding, same reasoning as Orivo's own
//! Ryujinx runner (`orivo/plugins/ryujinx/src/lib.rs`).
//!
//! ## Why the cursor is an index
//!
//! A cursor is capped at 256 bytes and must pass the same opaque-id grammar,
//! while a file name may be 255 bytes before hex doubles it. So the cursor is a
//! position in the sorted listing, exactly like Ryujinx's: it always fits, and
//! the host's own listing is sorted by name, so the position is stable across
//! calls as long as the folder does not change underneath the import.

wit_bindgen::generate!({
    world: "runner-plugin",
    // Relative to this crate's manifest directory — the same `wit/` directory
    // `wit/README.md` says to keep byte-identical to Orivo's contract.
    path: "wit",
});

use exports::orivo::plugin::{
    plugin_core::{Guest as CoreGuest, Health, Identity},
    runner::{
        Guest as RunnerGuest, LaunchIntent, ProfileValidation, RunnerGamePage, RunnerProfile,
    },
};
use orivo::plugin::{
    host_files::{self, DirectoryEntry},
    host_journal::{self, JournalLevel},
    types::{
        ExtensionKind, ExternalReference, GameCandidate, PageInfo, PageRequest, PluginError,
        PluginErrorCode,
    },
};

const PLUGIN_ID: &str = "com.orivo.gamestream";
/// Must equal `package/manifest.json`'s `version` and `Cargo.toml`'s: the
/// registry's pre-install gate asks the component who it is and refuses a
/// package that disagrees with its own manifest.
const PLUGIN_VERSION: &str = "0.2.1";

/// The one directory grant this component asks for. `games` is deliberately
/// the slot Orivo's "Add a folder" flow already grants
/// (`runner_commands::DEFAULT_DIRECTORY_SLOT`), so a user who grants the
/// default folder has granted this plugin everything it asks for — no other
/// slot exists for it to request.
const LIBRARY_GRANT: &str = "games";

/// What a placeholder file is called. One file, one streamable game.
const STREAM_SUFFIX: &str = ".stream";

/// The namespace no plain file name can enter; see the module docs.
const REFERENCE_PREFIX: &str = "x:";

/// The host refuses a page longer than the lesser of what was asked and its own
/// ceiling (`MAX_RESULT_PAGE_GAMES`), and that refusal fails the whole import
/// rather than truncating it — so the ceiling is applied here, before the
/// question can be asked.
const MAX_PAGE_GAMES: usize = 100;

/// A reference is an opaque id like any other: at most 256 bytes
/// (`MAX_RESULT_ID_BYTES`), and one over that limit is not a rejected
/// candidate but a rejected *page* (`candidate reference`). Hex doubles a name,
/// so a placeholder longer than 127 bytes is dropped here instead of failing
/// the import for every other game in the folder — see
/// `docs/03-regles-de-construction.md` §1.
const MAX_REFERENCE_BYTES: usize = 256;

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

struct GameStream;

impl CoreGuest for GameStream {
    fn get_identity() -> Identity {
        Identity {
            id: PLUGIN_ID.into(),
            version: PLUGIN_VERSION.into(),
            extensions: vec![ExtensionKind::Runner],
        }
    }

    fn health_check() -> Result<Health, PluginError> {
        Ok(Health {
            ready: true,
            message: None,
        })
    }
}

impl RunnerGuest for GameStream {
    /// Called with the profile's grants already resolved, but a profile is
    /// created *before* its first folder is allowed — so on the first pass
    /// `list-directory` would answer `permission-denied`. This therefore says
    /// nothing about folders: it accepts any non-empty profile id and leaves
    /// detection to the import, where a grant exists by construction.
    fn validate_profile(profile: RunnerProfile) -> Result<ProfileValidation, PluginError> {
        let valid = !profile.id.is_empty();
        Ok(ProfileValidation {
            valid,
            message: (!valid).then(|| "The profile has no identifier.".to_owned()),
        })
    }

    fn discover_page(
        _profile_id: String,
        request: PageRequest,
    ) -> Result<RunnerGamePage, PluginError> {
        let entries = match host_files::list_directory(LIBRARY_GRANT) {
            Ok(entries) => entries,
            Err(error) => {
                // A refused grant is only auditable when the attempt is
                // recorded beside it (host-journal, `wit/orivo-plugin.wit`).
                host_journal::log(
                    JournalLevel::Warning,
                    "the `games` folder is not granted; grant it in the profile first",
                );
                return Err(error);
            }
        };

        let limit = (request.limit as usize).min(MAX_PAGE_GAMES);
        // A zero-length ask cannot be answered with candidates — the host would
        // refuse the page — and a page of none is complete, not a stall.
        if limit == 0 {
            return Ok(RunnerGamePage {
                page: PageInfo {
                    next_cursor: None,
                    complete: true,
                },
                games: Vec::new(),
            });
        }

        // The host's listing arrives sorted by name and truncated to its own
        // bound; sorting here costs nothing at that bound and keeps this
        // component correct on its own terms.
        let mut stream_files: Vec<DirectoryEntry> = entries
            .into_iter()
            .filter(|entry| !entry.directory && stream_stem(&entry.name).is_some())
            .collect();
        let before_retain = stream_files.len();
        stream_files.retain(|entry| {
            entry.name.len() * 2 + REFERENCE_PREFIX.len() <= MAX_REFERENCE_BYTES
        });
        let dropped = before_retain - stream_files.len();
        if dropped > 0 {
            // One line, one host-call: the names themselves stay in the host's
            // journal, not here, and a silently vanishing file is the kind of
            // thing nobody ever finds again.
            host_journal::log(
                JournalLevel::Warning,
                "some .stream files were skipped: their names are too long to encode as references",
            );
        }
        stream_files.sort_by(|left, right| left.name.cmp(&right.name));

        let start = match request.cursor.as_deref() {
            None | Some("") => 0,
            Some(cursor) => cursor.parse::<usize>().map_err(|_| PluginError {
                code: PluginErrorCode::InvalidInput,
                message: "This runner did not issue that page cursor.".into(),
                retryable: false,
            })?,
        };

        let mut games = Vec::new();
        let mut next_cursor = None;
        for (index, entry) in stream_files.iter().enumerate().skip(start) {
            if games.len() == limit {
                next_cursor = Some(index.to_string());
                break;
            }
            let Some(stem) = stream_stem(&entry.name) else {
                continue;
            };
            games.push(GameCandidate {
                reference: ExternalReference {
                    provider_id: PLUGIN_ID.into(),
                    external_id: encode_name(&entry.name),
                },
                title: stem,
                sort_title: None,
                platform: None,
                // The placeholder is a file in a folder the user granted, so
                // there is nothing to check: it is local by construction.
                installed: true,
            });
        }

        Ok(RunnerGamePage {
            page: PageInfo {
                complete: next_cursor.is_none(),
                next_cursor,
            },
            games,
        })
    }

    /// Opaque ids only, echoed back exactly as received, plus the *name* of a
    /// launch shape — never its arguments.
    ///
    /// `"stream"` is the shape Orivo added for exactly this plugin
    /// (`docs/05-manques-et-plan.md` §3.2, now closed): the host reads the
    /// placeholder file it wrote itself, validates the two strings in it, and
    /// starts the profile's application with the closed argument list
    /// `stream <host> <app>`. That replaces the v0.1 wrapper recipe — the
    /// profile's application is the Moonlight binary now, not a script that
    /// has to interpret one file argument.
    ///
    /// Every game this component discovers is a `.stream` placeholder, because
    /// that is the only thing `discover_page` lists, so the shape is the same
    /// for all of them and is not derived from the reference. Naming it is also
    /// the whole of this component's say in the matter: the mode is an enum on
    /// the host side, the profile carries the user's own permission for it, and
    /// the host refuses the launch if the two disagree. A plugin that could
    /// name an argument list would be choosing its own command line.
    ///
    /// An Orivo without that shape answers `invalid-result("intent mode")` to
    /// a word it does not know, which fails the launch with a message about
    /// the plugin rather than about the host. The shape ships in **0.3.7**, so
    /// that is `minOrivoVersion` — it was `0.3.0` only for as long as the
    /// release had no number, and the floor was written here instead. An older
    /// Orivo now refuses the package at install time, which is where a version
    /// requirement should be refused rather than at the first Play.
    fn prepare_launch(
        profile_id: String,
        game_reference: String,
    ) -> Result<LaunchIntent, PluginError> {
        Ok(LaunchIntent {
            runner_id: PLUGIN_ID.into(),
            profile_id,
            game_reference,
            mode: "stream".into(),
        })
    }
}

/// The title of a placeholder, or `None` if `name` is not one. Suffix
/// comparison ignores case because the granted folder may sit on a
/// case-insensitive filesystem, where `X.stream` and `x.stream` are one file
/// and a case-sensitive rule would list it half the time.
///
/// `get` rather than indexing: a name that does *not* end in the suffix would
/// otherwise slice at `len - 7`, which for a multi-byte UTF-8 file name is
/// routinely not a character boundary — and a slice there is a panic, which the
/// host counts as a failed invocation rather than as a file to skip.
fn stream_stem(name: &str) -> Option<String> {
    let stem_len = name.len().checked_sub(STREAM_SUFFIX.len())?;
    let suffix = name.get(stem_len..)?;
    if stem_len == 0 || !suffix.eq_ignore_ascii_case(STREAM_SUFFIX) {
        return None;
    }
    Some(name[..stem_len].to_owned())
}

/// `x:` + the entry name in lower-case hexadecimal; see the module docs.
fn encode_name(name: &str) -> String {
    let mut encoded = String::with_capacity(REFERENCE_PREFIX.len() + name.len() * 2);
    encoded.push_str(REFERENCE_PREFIX);
    for byte in name.as_bytes() {
        encoded.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

export!(GameStream);
