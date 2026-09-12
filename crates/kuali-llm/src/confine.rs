//! Everything a locally installed CLI is allowed to touch.
//!
//! A transcript is text written by other people, and a CLI provider is an agent
//! that can act on what it reads. Three layers reduce that input to text-only
//! analysis and make a failure in one layer insufficient to expose the host:
//!
//! 1. The CLI is asked to refuse tools ([`tool_restrictions`]).
//! 2. Its environment is emptied of everything it was not given ([`inherited`]).
//! 3. On macOS the kernel denies the real home folder and child processes
//!    outright ([`profile`]).
//!
//! Kuali never needs any of this to succeed: retrieved passages reach the CLI on
//! stdin, so reading the meeting index is not a capability it has to keep.
//!
//! Only macOS carries the third layer today. The first two are portable and run
//! everywhere. Porting Kuali to another system means writing the kernel layer
//! for it first — Landlock or seccomp on Linux, a restricted token or an
//! AppContainer on Windows — because [`launch`] refuses to launch a CLI it cannot
//! confine, and the ports would otherwise ship with one layer missing.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use tokio::process::Command;

/// The flags that ask a CLI to refuse tools, and the home directories it still
/// needs in order to authenticate.
///
/// A program missing from this table cannot be launched at all, so a new
/// provider cannot reach a transcript before someone decides how to confine it.
struct Confinement {
    program: &'static str,
    restrictions: &'static [&'static str],
    /// Legacy provider paths relative to HOME that still have to be reopened.
    /// Codex deliberately has none: it receives only an ephemeral auth copy.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    owned: &'static [&'static str],
}

const CONFINEMENTS: &[Confinement] = &[
    Confinement {
        program: "claude",
        // Kuali only needs text. Disabling tools and MCP prevents filesystem,
        // network, or unrelated configured-server access, and `dontAsk` keeps an
        // unattended process from waiting on an approval nobody will give.
        restrictions: &[
            "--strict-mcp-config",
            "--disallowed-tools",
            "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task",
            "--permission-mode",
            "dontAsk",
        ],
        owned: &[".claude", ".claude.json"],
    },
    Confinement {
        program: "codex",
        // A meeting transcript is untrusted input, not an agent task. Do not
        // inherit the user's MCP servers, hooks, plugins, rules, skills or
        // session history, and remove every feature that can act on the host.
        // Unknown or removed flags make Codex fail closed after an incompatible
        // CLI upgrade instead of silently regaining a tool.
        restrictions: &[
            "--sandbox",
            "read-only",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "-c",
            "approval_policy=\"never\"",
            "--disable",
            "apps",
            "--disable",
            "browser_use",
            "--disable",
            "browser_use_external",
            "--disable",
            "browser_use_full_cdp_access",
            "--disable",
            "code_mode_host",
            "--disable",
            "computer_use",
            "--disable",
            "goals",
            "--disable",
            "hooks",
            "--disable",
            "image_generation",
            "--disable",
            "in_app_browser",
            "--disable",
            "in_app_local_automation",
            "--disable",
            "multi_agent",
            "--disable",
            "plugins",
            "--disable",
            "shell_snapshot",
            "--disable",
            "shell_tool",
            "--disable",
            "skill_mcp_dependency_install",
            "--disable",
            "skill_search",
            "--disable",
            "sleep_tool",
            "--disable",
            "tool_call_mcp_elicitation",
            "--disable",
            "tool_suggest",
            "--disable",
            "unified_exec",
            "--disable",
            "view_image",
            "--disable",
            "workspace_dependencies",
        ],
        // Authentication lives in the private scratch directory; exposing the
        // real directory would also expose config, MCPs and past sessions.
        owned: &[],
    },
    Confinement {
        program: "gemini",
        // Gemini exposes no way to drop its tools from the command line, so the
        // most this layer can do is refuse to inherit an `approvalMode` of
        // `yolo` from the user's settings. Everything else is left to the
        // kernel. Verified against the flag reference for v0.30.
        restrictions: &["--approval-mode", "default"],
        owned: &[".gemini"],
    },
];

fn confinement(program: &str) -> Option<&'static Confinement> {
    CONFINEMENTS.iter().find(|entry| entry.program == program)
}

/// The flags a provider must pass so the CLI refuses tools.
pub(crate) fn tool_restrictions(program: &str) -> Vec<String> {
    confinement(program)
        .map(|entry| entry.restrictions.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

/// Codex app-server has no `--ignore-user-config` switch. It receives a minimal
/// synthetic CODEX_HOME instead, while these global options keep every host
/// capability disabled if the server ever handles more than `model/list`.
pub(crate) fn codex_service_restrictions() -> Vec<String> {
    let summary = tool_restrictions("codex");
    let mut service = vec!["--strict-config".to_string()];
    for pair in summary.windows(2) {
        if pair[0] == "--disable" || pair[0] == "-c" {
            service.extend(pair.iter().cloned());
        }
    }
    service
}

/// Environment variables a confined CLI keeps. Everything else is dropped,
/// including every API key on the machine: a CLI authenticates through the
/// session the user already established, so a key in the environment is only
/// something to leak.
#[cfg(not(windows))]
const INHERITED: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TZ",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    // Some networks are reachable only through a proxy and its certificate.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    // Relocated CLI configuration. Without these the CLI cannot find the
    // session it is meant to reuse.
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

#[cfg(windows)]
const INHERITED: &[&str] = &[
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

/// The variables to hand a confined CLI, read from the current environment.
pub(crate) fn inherited() -> Vec<(&'static str, OsString)> {
    INHERITED
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (*name, value)))
        .collect()
}

/// Empties the environment and refills it with the little a CLI needs.
pub(crate) fn apply_environment(command: &mut Command, search_path: &OsStr) {
    command.env_clear();
    for (name, value) in inherited() {
        command.env(name, value);
    }
    command.env("PATH", search_path);
}

/// A private, single-use working directory for one meeting analysis.
///
/// Codex gets a synthetic HOME and a synthetic CODEX_HOME containing only a
/// private copy of `auth.json`. It cannot discover personal configuration,
/// sessions, MCP servers or plugins by walking from the real home directory.
pub(crate) struct SummarySandbox {
    directory: tempfile::TempDir,
    home: PathBuf,
    temporary: PathBuf,
    codex_home: Option<PathBuf>,
}

impl SummarySandbox {
    pub(crate) fn new(program: &str) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("kuali-summary-")
            .tempdir()
            .map_err(|error| format!("no se pudo crear el aislamiento temporal: {error}"))?;
        let home = directory.path().join("home");
        let temporary = directory.path().join("tmp");
        std::fs::create_dir_all(&home)
            .and_then(|_| std::fs::create_dir_all(&temporary))
            .map_err(|error| format!("no se pudo preparar el aislamiento temporal: {error}"))?;

        let codex_home = if program == "codex" {
            let source = codex_home_directory().join("auth.json");
            let isolated = directory.path().join("codex-home");
            std::fs::create_dir_all(&isolated).map_err(|error| {
                format!("no se pudo preparar la autenticación aislada de Codex: {error}")
            })?;
            let destination = isolated.join("auth.json");
            std::fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "no se pudo copiar la sesión de Codex desde {}: {error}",
                    source.display()
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o600))
                    .map_err(|error| {
                        format!("no se pudieron proteger las credenciales temporales: {error}")
                    })?;
            }
            Some(isolated)
        } else {
            None
        };

        Ok(Self {
            directory,
            home,
            temporary,
            codex_home,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        self.directory.path()
    }

    pub(crate) fn apply(&self, command: &mut Command) {
        command.env("TMPDIR", &self.temporary);
        if let Some(codex_home) = &self.codex_home {
            command.env("HOME", &self.home);
            command.env("CODEX_HOME", codex_home);
        }
    }
}

/// What has to stay alive for as long as the confined CLI runs. On macOS that
/// is the sandbox profile on disk. A platform with no kernel layer never
/// reaches this, which is why there is nothing for it to hold.
#[cfg(target_os = "macos")]
pub(crate) type Guard = Profile;
#[cfg(not(target_os = "macos"))]
pub(crate) type Guard = std::convert::Infallible;

/// Builds the command that runs a CLI under this platform's kernel sandbox, or
/// refuses when the platform has none to offer. The refusal is the point: it is
/// what makes a port implement this module instead of quietly shipping without
/// it.
pub(crate) fn launch(
    program: &str,
    executable: &Path,
    search_path: &OsStr,
    scratch: &Path,
) -> Result<(Command, Guard), String> {
    if confinement(program).is_none() {
        return Err(format!(
            "`{program}` no tiene reglas de confinamiento; \
             Kuali no ejecuta una CLI que no sabe encerrar"
        ));
    }

    isolate(program, executable, search_path, scratch)
}

#[cfg(target_os = "macos")]
fn isolate(
    program: &str,
    executable: &Path,
    search_path: &OsStr,
    scratch: &Path,
) -> Result<(Command, Guard), String> {
    let written =
        Profile::write(&profile(program, executable, search_path, scratch)).map_err(|error| {
            format!("no se pudo escribir el perfil de aislamiento de `{program}`: {error}")
        })?;

    let mut command = Command::new("/usr/bin/sandbox-exec");
    command.arg("-f").arg(written.path()).arg(executable);
    apply_environment(&mut command, search_path);
    Ok((command, written))
}

#[cfg(not(target_os = "macos"))]
fn isolate(
    program: &str,
    _executable: &Path,
    _search_path: &OsStr,
    _scratch: &Path,
) -> Result<(Command, Guard), String> {
    Err(format!(
        "Kuali todavía no sabe aislar procesos en este sistema, \
         así que no ejecuta `{program}`; usa un proveedor por API"
    ))
}

#[cfg(target_os = "macos")]
/// A sandbox profile on disk, removed when the launch is over.
pub(crate) struct Profile {
    file: tempfile::NamedTempFile,
}

#[cfg(target_os = "macos")]
impl Profile {
    fn write(text: &str) -> std::io::Result<Self> {
        use std::io::Write;

        let mut file = tempfile::Builder::new()
            .prefix("kuali-sandbox-")
            .suffix(".sb")
            .tempfile()?;
        file.write_all(text.as_bytes())?;
        file.flush()?;
        Ok(Self { file })
    }

    pub(crate) fn path(&self) -> &Path {
        self.file.path()
    }
}

/// Builds a Seatbelt profile that hides the home folder and forbids writing
/// anywhere the CLI does not own.
///
/// The rules are ordered deny-then-allow because Seatbelt applies the last
/// matching rule. Network access stays open: the CLI's whole job is to reach
/// its own API.
#[cfg(target_os = "macos")]
pub(crate) fn profile(
    program: &str,
    executable: &Path,
    search_path: &OsStr,
    scratch: &Path,
) -> String {
    let home = real_path(&home_directory());
    let scratch = real_path(scratch);

    let mut lines = vec![
        "(version 1)".to_string(),
        "(allow default)".to_string(),
        String::new(),
        "; Nothing on this machine may be modified.".to_string(),
        "(deny file-write*)".to_string(),
        "; The home folder does not exist as far as this process is concerned.".to_string(),
        format!("(deny file-read* (subpath {}))", quote(&home)),
        String::new(),
        "; Reopened: the runtime that executes the CLI.".to_string(),
    ];

    if program == "codex" {
        // Even a future Codex regression cannot launch a shell, hook, MCP
        // server, installer or helper. sandbox-exec itself must still be able
        // to replace its process with the reviewed Codex executable.
        lines.push("(deny process-exec)".to_string());
        for allowed in [executable.to_path_buf(), real_path(executable)] {
            let rule = format!("(allow process-exec (literal {}))", quote(&allowed));
            if !lines.contains(&rule) {
                lines.push(rule);
            }
        }
    }

    for directory in runtime_directories(executable, search_path, &home) {
        lines.push(format!(
            "(allow file-read* (subpath {}))",
            quote(&directory)
        ));
    }

    lines.push(String::new());
    lines.push("; Reopened: the minimum authentication material required by the CLI.".to_string());
    for owned in confinement(program).map(|entry| entry.owned).unwrap_or(&[]) {
        let path = real_path(&home.join(owned));
        lines.push(format!(
            "(allow file-read* file-write* (subpath {}))",
            quote(&path)
        ));
    }
    for relocated in ["CLAUDE_CONFIG_DIR"] {
        if let Some(value) = std::env::var_os(relocated) {
            let path = real_path(Path::new(&value));
            lines.push(format!(
                "(allow file-read* file-write* (subpath {}))",
                quote(&path)
            ));
        }
    }

    lines.push(String::new());
    lines.push(
        "; Reopened: provider support and this invocation's private scratch space.".to_string(),
    );
    if program != "codex" {
        for (relative, writable) in [
            ("Library/Caches", true),
            ("Library/Keychains", true),
            ("Library/Preferences", false),
        ] {
            let path = real_path(&home.join(relative));
            let operations = match writable {
                true => "file-read* file-write*",
                false => "file-read*",
            };
            lines.push(format!("(allow {operations} (subpath {}))", quote(&path)));
        }
    }
    lines.push(format!(
        "(allow file-read* file-write* (subpath {}))",
        quote(&scratch)
    ));
    // Node and its children expect the null device and the terminal to work.
    lines.push("(allow file-write* (subpath \"/dev\"))".to_string());
    lines.push(String::new());

    lines.join("\n")
}

/// The directories holding the CLI and the interpreter that runs it.
///
/// Package managers install both under the home folder, which the profile has
/// just hidden. Only their program directories are reopened, never the home
/// folder itself: these hold executables, not the user's documents.
#[cfg(target_os = "macos")]
fn runtime_directories(executable: &Path, search_path: &OsStr, home: &Path) -> Vec<PathBuf> {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut push = |candidate: PathBuf| {
        let candidate = real_path(&candidate);
        if candidate.starts_with(home) && !directories.contains(&candidate) {
            directories.push(candidate);
        }
    };

    // A launcher in `bin` usually runs code kept in a sibling `lib`.
    for directory in std::env::split_paths(search_path) {
        if directory.file_name() == Some(OsStr::new("bin")) {
            if let Some(root) = directory.parent() {
                push(root.join("lib"));
                push(root.join("libexec"));
            }
        }
        push(directory);
    }

    // Follow the shim to whatever it actually points at.
    if let Ok(resolved) = std::fs::canonicalize(executable) {
        if let Some(parent) = resolved.parent() {
            push(parent.to_path_buf());
        }
    }

    directories
}

fn home_directory() -> PathBuf {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn codex_home_directory() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_directory().join(".codex"))
}

/// Seatbelt matches resolved paths, and on macOS the temporary directory and the
/// home folder both reach their real location through symlinks.
#[cfg(target_os = "macos")]
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(target_os = "macos")]
fn quote(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{text}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_cli_declares_how_it_is_confined() {
        for program in ["claude", "codex", "gemini"] {
            let entry = confinement(program)
                .unwrap_or_else(|| panic!("`{program}` no declara confinamiento"));
            assert!(
                !entry.restrictions.is_empty(),
                "`{program}` no restringe herramientas"
            );
        }
        assert!(
            confinement("codex").unwrap().owned.is_empty(),
            "Codex no debe recuperar acceso a toda la carpeta .codex"
        );
    }

    #[test]
    fn an_undeclared_cli_is_not_launched() {
        // Discarding the success value keeps this readable on every platform:
        // the guard a sandbox hands back does not implement `Debug`.
        let error = launch(
            "cli-que-nadie-revisó",
            Path::new("/usr/bin/true"),
            OsStr::new("/usr/bin"),
            Path::new("/tmp/kuali-summary-test"),
        )
        .map(|_| ())
        .unwrap_err();
        assert!(error.contains("cli-que-nadie-revisó"));
    }

    #[test]
    fn no_api_key_reaches_a_confined_cli() {
        for name in INHERITED {
            let upper = name.to_uppercase();
            assert!(
                !upper.contains("API_KEY") && !upper.contains("TOKEN") && !upper.contains("SECRET"),
                "`{name}` no debería llegar a una CLI confinada"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_profile_hides_the_home_folder_before_reopening_what_the_cli_owns() {
        let home = real_path(&home_directory());
        let text = profile(
            "claude",
            &home.join(".nvm/versions/node/v25.7.0/bin/claude"),
            OsStr::new("/usr/bin:/bin"),
            Path::new("/tmp/kuali-summary-test"),
        );

        let denial = format!("(deny file-read* (subpath \"{}\"))", home.display());
        let reopened = format!(
            "(allow file-read* file-write* (subpath \"{}\"))",
            home.join(".claude").display()
        );
        assert!(text.contains(&denial), "{text}");
        assert!(text.contains(&reopened), "{text}");
        assert!(text.contains("(deny file-write*)"));
        // Seatbelt applies the last matching rule, so the denial has to come first.
        assert!(text.find(&denial) < text.find(&reopened));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_profile_reopens_the_runtime_that_lives_under_the_home_folder() {
        let home = real_path(&home_directory());
        let node = home.join(".nvm/versions/node/v25.7.0/bin");
        let path = std::env::join_paths([node.clone(), PathBuf::from("/usr/bin")]).unwrap();
        let text = profile(
            "claude",
            &node.join("claude"),
            &path,
            Path::new("/tmp/kuali-summary-test"),
        );

        assert!(
            text.contains(&format!("(subpath \"{}\")", node.display())),
            "{text}"
        );
        assert!(
            text.contains(&format!(
                "(subpath \"{}\")",
                node.parent().unwrap().join("lib").display()
            )),
            "{text}"
        );
        // Only program directories are reopened, never the home folder itself.
        assert!(!text.contains(&format!(
            "(allow file-read* (subpath \"{}\"))",
            home.display()
        )));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_sandboxed_process_cannot_read_the_home_folder() {
        let scratch = tempfile::tempdir().unwrap();
        let text = profile(
            "claude",
            Path::new("/bin/cat"),
            OsStr::new("/usr/bin:/bin"),
            scratch.path(),
        );
        let written = Profile::write(&text).unwrap();
        let probe = home_directory().join(".kuali-sandbox-probe");
        std::fs::write(&probe, "secreto").unwrap();

        let output = tokio::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-f")
            .arg(written.path())
            .arg("/bin/cat")
            .arg(&probe)
            .output()
            .await
            .unwrap();

        std::fs::remove_file(&probe).unwrap();
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("secreto"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_codex_profile_cannot_read_the_real_auth_file() {
        let scratch = tempfile::tempdir().unwrap();
        let text = profile(
            "codex",
            Path::new("/bin/cat"),
            OsStr::new("/usr/bin:/bin"),
            scratch.path(),
        );
        let written = Profile::write(&text).unwrap();
        let output = tokio::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-f")
            .arg(written.path())
            .arg("/bin/cat")
            .arg(codex_home_directory().join("auth.json"))
            .output()
            .await
            .unwrap();

        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn the_codex_profile_cannot_launch_a_child_process() {
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("child-ran");
        let text = profile(
            "codex",
            Path::new("/bin/bash"),
            OsStr::new("/usr/bin:/bin"),
            scratch.path(),
        );
        let written = Profile::write(&text).unwrap();
        let output = tokio::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-f")
            .arg(written.path())
            .arg("/bin/bash")
            .arg("-c")
            .arg(format!("/usr/bin/touch {}", marker.display()))
            .output()
            .await
            .unwrap();

        assert!(!output.status.success());
        assert!(!marker.exists());
    }

    #[test]
    fn codex_is_ephemeral_and_every_host_tool_is_disabled() {
        let restrictions = tool_restrictions("codex");
        for required in [
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
        ] {
            assert!(restrictions.iter().any(|value| value == required));
        }
        for feature in [
            "apps",
            "browser_use",
            "computer_use",
            "hooks",
            "multi_agent",
            "plugins",
            "shell_tool",
            "unified_exec",
            "workspace_dependencies",
        ] {
            assert!(restrictions
                .windows(2)
                .any(|pair| pair == ["--disable", feature]));
        }
        assert!(restrictions
            .windows(2)
            .any(|pair| pair == ["-c", "approval_policy=\"never\""]));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_cannot_see_its_real_home_or_execute_children() {
        let home = real_path(&home_directory());
        let executable = Path::new("/Applications/ChatGPT.app/Contents/Resources/codex");
        let scratch = Path::new("/tmp/kuali-summary-test");
        let text = profile("codex", executable, OsStr::new("/usr/bin:/bin"), scratch);
        let codex_home = real_path(&codex_home_directory());

        assert!(text.contains("(deny process-exec)"), "{text}");
        assert!(text.contains(&format!(
            "(allow process-exec (literal {}))",
            quote(executable)
        )));
        assert!(!text.contains(&format!(
            "(allow file-read* file-write* (subpath {}))",
            quote(&codex_home)
        )));
        assert!(!text.contains(&format!(
            "(allow file-read* (literal {}))",
            quote(&codex_home.join("auth.json"))
        )));
        assert!(!text.contains("Library/Keychains"), "{text}");
        assert!(!text.contains("Library/Caches"), "{text}");
        assert!(text.contains(&format!(
            "(allow file-read* file-write* (subpath {}))",
            quote(scratch)
        )));
        assert!(text.contains(&format!("(deny file-read* (subpath {}))", quote(&home))));
    }
}
