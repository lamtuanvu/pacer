//! Update-time staged signing, ported from `src/update/signing.ts:signStaged` and
//! `crates/cli/src/self_repair/process.rs:sign`. A failure leaves the staged binary
//! ad hoc signed instead of failing the update, and reports why on stderr.
use std::{io::Read, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

const IDENTITY: &str = "pacer local code signing";
const IDENTIFIER: &str = "dev.pacer.cli";

/// Bound elapsed time and output, including when a descendant retains stdout.
fn output(program: &Path, args: &[&str], seconds: u64) -> Option<Vec<u8>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    runtime.block_on(async {
        let mut child = Command::new(program)
            .args(args)
            .env_remove("BUN_OPTIONS")
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let mut stderr = child.stderr.take()?;
        let result = tokio::time::timeout(Duration::from_secs(seconds), async {
            let mut bytes = Vec::new();
            let mut errors = Vec::new();
            let read = async {
                (&mut stdout).take(65537).read_to_end(&mut bytes).await.ok()?;
                (&mut stderr).take(65537).read_to_end(&mut errors).await.ok()?;
                Some(())
            };
            if read.await.is_none() || bytes.len() > 65536 || errors.len() > 65536 {
                return None;
            }
            let status = child.wait().await.ok()?;
            Some((status.success(), bytes, errors))
        })
        .await;
        match result {
            Ok(Some((true, bytes, _))) => Some(bytes),
            Ok(Some((false, _, errors))) => {
                let text = String::from_utf8_lossy(&errors).trim().to_owned();
                eprintln!(
                    "pacer: could not sign the update as {IDENTIFIER} ({}); macOS may ask for removable-volume access again.",
                    if text.is_empty() {
                        "timed out or requires authorization".into()
                    } else {
                        text
                    }
                );
                None
            }
            _ => {
                let _ = child.kill().await;
                eprintln!(
                    "pacer: could not sign the update as {IDENTIFIER} (timed out or requires authorization); macOS may ask for removable-volume access again."
                );
                None
            }
        }
    })
}

/// Match the `security find-identity` line for pacer's own local signing certificate.
fn find_identity() -> Option<String> {
    let bytes = output(
        Path::new("/usr/bin/security"),
        &["find-identity", "-v", "-p", "codesigning"],
        3,
    )?;
    String::from_utf8_lossy(&bytes).lines().find_map(|line| {
        let words: Vec<_> = line.split_whitespace().collect();
        let hash = *words.get(1)?;
        (line.trim_end().ends_with(&format!("\"{IDENTITY}\""))
            && hash.len() == 40
            && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hash.to_owned())
    })
}

/// Only native Mach-O files need signing; scripts stay useful as smoke fixtures.
fn is_macho(path: &Path) -> bool {
    let mut magic = [0; 4];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_ok()
        && matches!(
            u32::from_be_bytes(magic),
            0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe | 0xbebafeca
        )
}

/// `signStaged`: macOS + Mach-O only. Any failure is reported and swallowed so the
/// staged binary is still installed (ad hoc signed) and the update can finish.
pub fn sign_staged(path: &Path) -> bool {
    if !cfg!(target_os = "macos") || !is_macho(path) {
        return false;
    }
    let Some(hash) = find_identity() else {
        // signStaged passes a no-op log to signLocal, so a missing identity is quiet.
        return false;
    };
    let requirement =
        format!("=designated => identifier \"{IDENTIFIER}\" and certificate leaf = H\"{hash}\"");
    let Some(file) = path.to_str() else {
        eprintln!(
            "pacer: could not sign the update as {IDENTIFIER} (non-UTF-8 executable path); macOS may ask for removable-volume access again."
        );
        return false;
    };
    output(
        Path::new("/usr/bin/codesign"),
        &[
            "-f",
            "-s",
            &hash,
            "-i",
            IDENTIFIER,
            "--options",
            "0",
            "-r",
            &requirement,
            file,
        ],
        15,
    )
    .is_some()
        && output(
            Path::new("/usr/bin/codesign"),
            &["--verify", "--strict", file],
            15,
        )
        .is_some()
}
