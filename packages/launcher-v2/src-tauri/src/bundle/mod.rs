//! Source-tree provisioning + bundled-Deno staging + dep-cache warm.
//!
//! Three pure-logic functions (no Tauri deps) that together do the work of
//! making `<launcher_data_dir>/` ready for the daemon to launch:
//!
//! 1. `clone_or_fetch_source` — shallow-clone the public Psycheros repo
//!    to `<data>/source/` on first run, or fetch+reset to upstream on
//!    update. Returns the resulting HEAD SHA so the caller can stamp it
//!    in `config.bundled_source_version` for later update comparisons.
//! 2. `stage_bundled_deno` — copy the Tauri sidecar Deno binary to the
//!    stable `<data>/bin/deno` path. The OS supervisor's service
//!    definition references this stable path so it survives shell
//!    auto-updates.
//! 3. `warm_deno_cache` — populate Deno's dep cache against the cloned
//!    source. Slow (~30-60s on a cold machine) — needs a progress UI.
//!
//! The Tauri command in `commands.rs` orchestrates these three calls and
//! forwards progress to the frontend as `first-run-progress` events.
//!
//! Architecture note (2026-05-19): this module previously extracted an
//! embedded `release-bundle.tar.gz` for source. Switched to git clone so
//! psycheros source updates can flow through git tags without requiring
//! a new .app re-download per release. See PR / commit history for the
//! rationale.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{ExitStatus, Stdio};

use thiserror::Error;

use crate::proc::hidden_command;

#[derive(Debug, Error)]
pub enum BundleError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("deno cache failed ({status})\n{stderr_tail}")]
    DenoCache {
        status: ExitStatus,
        stderr_tail: String,
    },
    #[error("git {op} failed ({status})")]
    Git {
        op: &'static str,
        status: ExitStatus,
    },
    #[error("git not found on PATH")]
    GitMissing,
    #[error("git emitted non-utf8 output (unexpected for rev-parse)")]
    GitNonUtf8,
}

/// Provision `<target>` to mirror `<repo_url>@<git_ref>`.
///
/// `git_ref` may be a branch name or a tag name — `git clone --branch`
/// accepts both, and the fetch+reset path uses `FETCH_HEAD` (which the
/// most recent fetch sets to whatever ref it pulled) so the same code
/// covers both cases. The tagged-release model
/// ([`commands::SOURCE_TAG_PREFIX`]) passes resolved tag names through
/// here; the older rolling-main model passed `"main"`.
///
/// Idempotent: if `<target>/.git` already exists, runs `git fetch` +
/// `git reset --hard FETCH_HEAD`. If `<target>` doesn't exist (or has no
/// `.git`), runs a shallow `git clone --depth 1 --branch <git_ref>`.
///
/// Returns the resulting HEAD commit SHA (full, untrimmed of the
/// trailing newline) — the caller doesn't have to stamp this; it's
/// useful for logging and verification. The caller stamps `git_ref`
/// into `config.bundled_source_version` because that's the
/// human-meaningful identifier (tag name) for update comparisons.
///
/// `on_progress` is called once per stderr line from the git subprocess
/// — git emits "Receiving objects: X%", "Resolving deltas: Y%", etc.
/// during a clone, which the first-run UI can surface to indicate the
/// command isn't hung.
pub fn clone_or_fetch_source(
    repo_url: &str,
    git_ref: &str,
    target: &Path,
    mut on_progress: impl FnMut(&str),
) -> Result<String, BundleError> {
    let git = locate_git()?;

    if target.join(".git").exists() {
        // Update an existing clone. Fetch shallow then hard-reset to
        // FETCH_HEAD so the working tree matches the just-fetched ref
        // exactly. FETCH_HEAD works for both branches and tags — git
        // doesn't always create a remote-tracking ref for tags, so the
        // older `origin/<ref>` form would have broken for tag updates.
        run_git_streaming(
            &git,
            target,
            "fetch",
            &["fetch", "--progress", "--depth", "1", "origin", git_ref],
            &mut on_progress,
        )?;
        run_git_streaming(
            &git,
            target,
            "reset",
            &["reset", "--hard", "FETCH_HEAD"],
            &mut on_progress,
        )?;
    } else {
        // No clone yet. Wipe any partial state and shallow-clone fresh.
        if target.exists() {
            std::fs::remove_dir_all(target)?;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // git clone runs from any cwd; the target path is its last positional.
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        let target_str = target.to_string_lossy().into_owned();
        run_git_streaming(
            &git,
            parent,
            "clone",
            &[
                "clone",
                "--progress",
                "--depth",
                "1",
                "--branch",
                git_ref,
                repo_url,
                &target_str,
            ],
            &mut on_progress,
        )?;
    }

    capture_head_sha(&git, target)
}

/// Copy a sidecar binary from its Tauri-resources location to a stable
/// launcher-data-dir path. The service supervisor's task / plist / unit
/// definition references the stable path, so it survives launcher
/// auto-update (where the binary inside the `.app` / `.exe` bundle moves
/// per build).
///
/// Overwrites `dest` if it exists. On Unix, sets mode `0o755` so the
/// service supervisor can `exec` the file — `std::fs::copy` preserves
/// source permissions, but I don't want to depend on the sidecar being
/// shipped with the executable bit (Tauri's resource staging is not
/// guaranteed to preserve it across all platforms / install paths).
///
/// Generic over which sidecar — Deno, the Windows daemon runner, or any
/// future bundled tool. The previous name `stage_bundled_deno` survives
/// as a thin alias for source compatibility, but new call sites should
/// prefer the generic name.
pub fn stage_bundled_binary(sidecar_path: &Path, dest: &Path) -> Result<(), BundleError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(sidecar_path, dest)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dest, perms)?;
    }

    Ok(())
}

/// Backwards-compatible alias for [`stage_bundled_binary`]. Predates the
/// Windows daemon-runner sidecar, when Deno was the only bundled
/// executable. Kept so external callers + the existing first-run path
/// don't need a flag-day rename.
pub fn stage_bundled_deno(sidecar_path: &Path, dest: &Path) -> Result<(), BundleError> {
    stage_bundled_binary(sidecar_path, dest)
}

/// Run `deno cache src/main.ts` against the extracted psycheros package
/// to populate Deno's dep cache.
///
/// This is the slow step (~30-60s on a cold machine pulling all npm/jsr
/// deps; near-instant on a warm one). `on_line` is invoked for each line
/// `deno cache` writes to stderr so the first-run UI can render live
/// progress instead of looking hung.
///
/// `source_dir` must be the psycheros package root (the directory
/// containing `src/main.ts`), not the workspace root. `deno_path` is the
/// staged binary at `paths::bundled_deno_path()`.
///
/// The `--allow-scripts` flag is required because Psycheros depends on
/// native npm packages with postinstall scripts — most notably
/// `onnxruntime-node` (embeddings) and `sharp` (image processing).
/// Deno 2.x blocks these scripts by default as a security measure;
/// without the flag, `deno cache` exits non-zero with
/// `error: failed to run scripts for packages: onnxruntime-node, ...`
/// during first-run. We trust the Psycheros source we just cloned at a
/// pinned tag, so the broad form (allow all) is appropriate — same
/// posture as the `-A` (allow-all-perms) flag the daemon itself runs
/// with at execution time.
///
/// **Known Deno 2.x limitation**: Even with `--allow-scripts`, the
/// lifecycle scripts can fail because Deno's `nodeModulesDir:"auto"`
/// layout (flat `.deno/<pkg>@<ver>/` dirs) doesn't place sibling
/// packages on Node's `require()` resolution path. `sharp` can't find
/// `semver/functions/coerce`; `onnxruntime-node` can't find its deps
/// either. The scripts fail and `deno cache` exits 1, but all packages
/// are fully downloaded and the daemon works fine at runtime. When the
/// "failed to run scripts for packages" pattern appears in stderr, we
/// treat it as a non-fatal warning instead of aborting the first-run
/// flow.
pub fn warm_deno_cache(
    deno_path: &Path,
    source_dir: &Path,
    mut on_line: impl FnMut(&str),
) -> Result<(), BundleError> {
    let mut child = hidden_command(deno_path)
        .arg("cache")
        .arg("--allow-scripts")
        .arg("src/main.ts")
        .current_dir(source_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    // `deno cache` writes progress exclusively to stderr; stdout stays
    // empty, so draining stderr serially (no second thread) is enough.
    // Keep a rolling window of the last N lines so the error includes
    // the actual deno diagnostics instead of just the exit code.
    const STDERR_TAIL_LEN: usize = 15;
    let mut tail: Vec<String> = Vec::with_capacity(STDERR_TAIL_LEN);

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = line?;
            on_line(&line);
            if tail.len() >= STDERR_TAIL_LEN {
                tail.remove(0);
            }
            tail.push(line);
        }
    }

    let status = child.wait()?;
    if !status.success() {
        let stderr_tail = tail.join("\n");
        // Deno 2.x with nodeModulesDir:"auto" lays packages out in a flat
        // .deno/<pkg>@<ver>/ structure that Node's require() can't always
        // resolve from lifecycle scripts. When onnxruntime-node and sharp
        // run their postinstall scripts, they fail to require sibling deps
        // (e.g. semver/functions/coerce), deno exits 1, but all packages
        // are fully installed and the daemon works fine at runtime. Detect
        // this specific pattern and treat it as a non-fatal warning.
        if stderr_tail.contains("failed to run scripts for packages") {
            on_line(
                "warning: lifecycle scripts failed (deno node_modules layout); \
                 packages are installed, proceeding",
            );
            return Ok(());
        }
        return Err(BundleError::DenoCache {
            status,
            stderr_tail,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Find the `git` binary on PATH. Returns `GitMissing` if not found;
/// the frontend renders a platform-specific remediation UI.
fn locate_git() -> Result<std::path::PathBuf, BundleError> {
    let lookup = if cfg!(windows) { "where" } else { "which" };
    let out = hidden_command(lookup).arg("git").output()?;
    if !out.status.success() {
        return Err(BundleError::GitMissing);
    }
    let stdout = String::from_utf8(out.stdout).map_err(|_| BundleError::GitNonUtf8)?;
    let first = stdout.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        return Err(BundleError::GitMissing);
    }
    Ok(std::path::PathBuf::from(first))
}

/// Run a git subcommand with stderr streamed line-by-line through the
/// callback. Errors carry the operation name so the user-facing message
/// can say "git clone failed" vs. "git fetch failed."
///
/// `args` is the full git argv after the binary itself; callers that
/// want progress output should include `--progress` explicitly. (Not all
/// git subcommands accept it — `reset` for instance rejects it as a
/// usage error.)
fn run_git_streaming(
    git: &Path,
    cwd: &Path,
    op: &'static str,
    args: &[&str],
    on_line: &mut dyn FnMut(&str),
) -> Result<(), BundleError> {
    let mut child = hidden_command(git)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = line?;
            on_line(&line);
        }
    }

    let status = child.wait()?;
    if !status.success() {
        return Err(BundleError::Git { op, status });
    }
    Ok(())
}

/// Capture the current HEAD SHA of a clone via `git rev-parse HEAD`.
/// Returned with the trailing newline trimmed.
fn capture_head_sha(git: &Path, target: &Path) -> Result<String, BundleError> {
    let out = hidden_command(git)
        .args(["rev-parse", "HEAD"])
        .current_dir(target)
        .output()?;
    if !out.status.success() {
        return Err(BundleError::Git {
            op: "rev-parse",
            status: out.status,
        });
    }
    let sha = String::from_utf8(out.stdout).map_err(|_| BundleError::GitNonUtf8)?;
    Ok(sha.trim().to_string())
}

/// List all tags on `repo_url` matching `<prefix><semver>`, sort by
/// semver, return the highest tag's full name. Returns `Ok(None)` when
/// no tags match — the launcher uses this to detect "upstream hasn't
/// cut a release yet" as a distinct case from network failure.
///
/// Used by the update-detection flow: compare the returned tag against
/// `config.bundled_source_version` to decide whether to offer an
/// update. Pure read — runs `git ls-remote --tags --refs` without
/// touching any local clone state.
///
/// `prefix` is the literal string before the semver part (e.g.
/// `"psycheros-v"`). Tags that don't start with the prefix or whose
/// suffix doesn't parse as semver are ignored — so `launcher-v*` or
/// random tags coexisting in the repo don't confuse the resolution.
pub fn query_latest_tag(repo_url: &str, prefix: &str) -> Result<Option<String>, BundleError> {
    let git = locate_git()?;
    // `--refs` drops the `^{}` peeled-tag entries from the output, which
    // would otherwise show up as duplicates for annotated tags.
    let out = hidden_command(&git)
        .args(["ls-remote", "--tags", "--refs", repo_url])
        .output()?;
    if !out.status.success() {
        return Err(BundleError::Git {
            op: "ls-remote --tags",
            status: out.status,
        });
    }
    let stdout = String::from_utf8(out.stdout).map_err(|_| BundleError::GitNonUtf8)?;

    // Each line is `<sha>\trefs/tags/<tag-name>`. Parse, filter, sort.
    let mut candidates: Vec<(semver::Version, String)> = stdout
        .lines()
        .filter_map(|line| {
            let tag_name = line.split('\t').nth(1)?.strip_prefix("refs/tags/")?;
            let version_str = tag_name.strip_prefix(prefix)?;
            let version = semver::Version::parse(version_str).ok()?;
            Some((version, tag_name.to_string()))
        })
        .collect();

    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(candidates.pop().map(|(_, name)| name))
}

/// List every tag matching `prefix`, sorted highest-semver first.
/// Used by the launcher's "Install a specific version" picker; lets
/// the user roll forward or backward across all released versions on
/// their chosen channel without manual git work.
///
/// Same parsing rules as [`query_latest_tag`] — non-prefix-matching
/// or non-semver-suffixed tags are silently filtered out.
pub fn list_tags(repo_url: &str, prefix: &str) -> Result<Vec<String>, BundleError> {
    let git = locate_git()?;
    let out = hidden_command(&git)
        .args(["ls-remote", "--tags", "--refs", repo_url])
        .output()?;
    if !out.status.success() {
        return Err(BundleError::Git {
            op: "ls-remote --tags",
            status: out.status,
        });
    }
    let stdout = String::from_utf8(out.stdout).map_err(|_| BundleError::GitNonUtf8)?;
    let mut candidates: Vec<(semver::Version, String)> = stdout
        .lines()
        .filter_map(|line| {
            let tag_name = line.split('\t').nth(1)?.strip_prefix("refs/tags/")?;
            let version_str = tag_name.strip_prefix(prefix)?;
            let version = semver::Version::parse(version_str).ok()?;
            Some((version, tag_name.to_string()))
        })
        .collect();
    // Descending by semver — most recent first.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(candidates.into_iter().map(|(_, name)| name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::Command;

    // --- stage_bundled_deno --------------------------------------------------

    #[test]
    fn stages_deno_and_sets_exec_perms() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("source").join("deno");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, b"#!/bin/sh\necho deno\n").unwrap();

        let dest = dir.path().join("bin").join("deno");
        stage_bundled_deno(&sidecar, &dest).unwrap();

        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"#!/bin/sh\necho deno\n");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
        }
    }

    #[test]
    fn stage_overwrites_existing_deno() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("source").join("deno");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, b"new-version").unwrap();

        let dest = dir.path().join("bin").join("deno");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, b"old-version").unwrap();

        stage_bundled_deno(&sidecar, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new-version");
    }

    #[test]
    fn stage_creates_missing_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("source").join("deno");
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, b"x").unwrap();

        let dest = dir
            .path()
            .join("brand")
            .join("new")
            .join("bin")
            .join("deno");
        stage_bundled_deno(&sidecar, &dest).unwrap();
        assert!(dest.exists());
    }

    // --- warm_deno_cache (Unix-only, uses a fake-deno shell script) ---------

    #[cfg(unix)]
    fn write_executable_script(path: &Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, script).unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn warm_cache_streams_stderr_lines() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake-deno");
        write_executable_script(
            &fake,
            "#!/bin/sh\n\
             echo 'Download https://example.com/a.ts' >&2\n\
             echo 'Download https://example.com/b.ts' >&2\n\
             exit 0\n",
        );
        let source = dir.path().join("source");
        std::fs::create_dir_all(&source).unwrap();

        let mut lines: Vec<String> = vec![];
        warm_deno_cache(&fake, &source, |l| lines.push(l.to_string())).unwrap();
        assert_eq!(
            lines,
            vec![
                "Download https://example.com/a.ts".to_string(),
                "Download https://example.com/b.ts".to_string(),
            ],
        );
    }

    #[cfg(unix)]
    #[test]
    fn warm_cache_errs_on_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake-deno");
        write_executable_script(
            &fake,
            "#!/bin/sh\necho 'fatal: registry unreachable' >&2\nexit 1\n",
        );
        let source = dir.path().join("source");
        std::fs::create_dir_all(&source).unwrap();

        let result = warm_deno_cache(&fake, &source, |_| {});
        assert!(matches!(result, Err(BundleError::DenoCache { .. })));
    }

    // --- clone_or_fetch_source: tests against a local "remote" repo --------
    //
    // I make a bare-ish git repo in a tempdir, commit a file, then point
    // clone_or_fetch_source at it. This gives end-to-end coverage of the
    // shell-out path (which-lookup, clone, fetch, reset, rev-parse) without
    // touching the network.

    #[cfg(unix)]
    fn run(cmd: &str, cwd: &Path) {
        let status = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(cwd)
            .status()
            .expect("spawn sh");
        assert!(status.success(), "command failed: {cmd}");
    }

    #[cfg(unix)]
    fn make_local_remote(remote_dir: &Path, branch: &str) {
        std::fs::create_dir_all(remote_dir).unwrap();
        // -c flags pin identity so the test doesn't depend on the user's
        // ambient git config (which may be empty in CI).
        run(
            &format!(
                "git -c user.name=test -c user.email=t@t -c init.defaultBranch={branch} init -q"
            ),
            remote_dir,
        );
        std::fs::write(remote_dir.join("hello.txt"), "world").unwrap();
        run("git add hello.txt", remote_dir);
        run(
            "git -c user.name=test -c user.email=t@t commit -q -m initial",
            remote_dir,
        );
    }

    /// Append a commit + lightweight tag to an existing local repo.
    #[cfg(unix)]
    fn tag_commit(remote: &Path, tag: &str, marker: &str) {
        std::fs::write(remote.join("f.txt"), marker).unwrap();
        run("git add f.txt", remote);
        run(
            &format!("git -c user.name=test -c user.email=t@t commit -q -m {tag}"),
            remote,
        );
        run(&format!("git tag {tag}"), remote);
    }

    #[cfg(unix)]
    #[test]
    fn query_latest_tag_returns_highest_semver_with_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote");
        make_local_remote(&remote, "main");

        // Mix: matching prefix in non-sorted order, a non-matching prefix,
        // and a "v0.10.0" that string-sorts BEFORE v0.2.0 (the classic
        // naive-string-sort trap that semver parsing must defeat).
        tag_commit(&remote, "psycheros-v0.1.0", "a");
        tag_commit(&remote, "psycheros-v0.10.0", "b");
        tag_commit(&remote, "psycheros-v0.2.0", "c");
        tag_commit(&remote, "launcher-v1.0.0", "d");
        tag_commit(&remote, "random-tag", "e");

        let url = remote.to_string_lossy().into_owned();
        let result = query_latest_tag(&url, "psycheros-v").unwrap();
        assert_eq!(result, Some("psycheros-v0.10.0".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn query_latest_tag_returns_none_when_no_matches() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote");
        make_local_remote(&remote, "main");
        tag_commit(&remote, "launcher-v1.0.0", "a");
        tag_commit(&remote, "random-tag", "b");

        let url = remote.to_string_lossy().into_owned();
        let result = query_latest_tag(&url, "psycheros-v").unwrap();
        assert_eq!(result, None);
    }

    #[cfg(unix)]
    #[test]
    fn query_latest_tag_returns_none_on_empty_remote() {
        // No commits, no tags. ls-remote still exits 0, just emits empty
        // output — we should report None, not error.
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote");
        std::fs::create_dir_all(&remote).unwrap();
        run(
            "git -c user.name=test -c user.email=t@t -c init.defaultBranch=main init -q",
            &remote,
        );

        let url = remote.to_string_lossy().into_owned();
        let result = query_latest_tag(&url, "psycheros-v").unwrap();
        assert_eq!(result, None);
    }

    #[cfg(unix)]
    #[test]
    fn clones_at_tag_then_advances_to_newer_tag() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote");
        let local = dir.path().join("local");
        make_local_remote(&remote, "main");
        tag_commit(&remote, "psycheros-v0.1.0", "v1");

        let url = remote.to_string_lossy().into_owned();

        // Initial clone at v0.1.0.
        let sha1 = clone_or_fetch_source(&url, "psycheros-v0.1.0", &local, |_| {}).unwrap();
        assert_eq!(std::fs::read_to_string(local.join("f.txt")).unwrap(), "v1",);

        // Add a newer tag on the remote.
        tag_commit(&remote, "psycheros-v0.2.0", "v2");

        // Fetch+reset to the newer tag — verifies the FETCH_HEAD-based
        // reset path works for tag refs (the older `origin/<ref>` form
        // would have failed here since git doesn't always create
        // remote-tracking refs for tags).
        let sha2 = clone_or_fetch_source(&url, "psycheros-v0.2.0", &local, |_| {}).unwrap();
        assert_ne!(sha1, sha2, "advancing tags should produce a new HEAD SHA");
        assert_eq!(std::fs::read_to_string(local.join("f.txt")).unwrap(), "v2",);
    }

    #[cfg(unix)]
    #[test]
    fn clones_then_fetches_to_advance() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote");
        let local = dir.path().join("local");

        make_local_remote(&remote, "main");
        let remote_url = remote.to_string_lossy().into_owned();

        // First call: fresh clone.
        let sha1 = clone_or_fetch_source(&remote_url, "main", &local, |_| {}).unwrap();
        assert!(local.join(".git").exists());
        assert!(local.join("hello.txt").exists());
        assert_eq!(sha1.len(), 40, "rev-parse HEAD should be a full SHA");

        // Advance the remote.
        std::fs::write(remote.join("hello.txt"), "world-v2").unwrap();
        run("git add hello.txt", &remote);
        run(
            "git -c user.name=test -c user.email=t@t commit -q -m advance",
            &remote,
        );

        // Second call: fetch + reset to new HEAD.
        let sha2 = clone_or_fetch_source(&remote_url, "main", &local, |_| {}).unwrap();
        assert_ne!(sha1, sha2, "HEAD should advance after fetch+reset");
        assert_eq!(
            std::fs::read_to_string(local.join("hello.txt")).unwrap(),
            "world-v2",
        );
    }
}
