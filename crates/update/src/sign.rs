//! Update-time signing: `signStaged` from `src/update/signing.ts`, ported from the
//! Rust self-repair signer in `crates/cli/src/self_repair/process.rs`.
//!
//! Signing is best effort: a failure leaves the staged binary ad hoc signed and
//! reports `false` with the TypeScript log line instead of failing the update.
use std::{io::Read, path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

const SIGNING_IDENTITY: &str = "pacer local code signing";
const SIGNING_IDENTIFIER: &str = "dev.pacer.cli";

/// Bound both elapsed time and output, including when a descendant retains stdout.
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
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let result = tokio::time::timeout(Duration::from_secs(seconds), async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(65537)
                .read_to_end(&mut bytes)
                .await
                .ok()?;
            if bytes.len() > 65536 {
                return None;
            }
            child.wait().await.ok()?.success().then_some(bytes)
        })
        .await;
        match result {
            Ok(Some(bytes)) => Some(bytes),
            _ => {
                let _ = child.kill().await;
                None
            }
        }
    })
}

fn find_identity() -> Option<String> {
    // Metadata lookup for pacer's own signing identity; no planner/executor credentials.
    let bytes = output(
        Path::new("/usr/bin/security"),
        &["find-identity", "-v", "-p", "codesigning"],
        3,
    )?;
    let text = String::from_utf8_lossy(&bytes);
    text.lines().find_map(|line| {
        let words: Vec<_> = line.split_whitespace().collect();
        let hash = *words.get(1)?;
        (line
            .trim_end()
            .ends_with(&format!("\"{SIGNING_IDENTITY}\""))
            && hash.len() == 40
            && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hash.to_owned())
    })
}

fn is_macho(path: &Path) -> bool {
    let mut magic = [0; 4];
    if std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_err()
    {
        return false;
    }
    matches!(
        u32::from_be_bytes(magic),
        0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe | 0xbebafeca
    )
}

fn checked(program: &str, args: &[&str], seconds: u64) -> Result<(), String> {
    output(Path::new(program), args, seconds)
        .map(|_| ())
        .ok_or_else(|| format!("{program} {} failed", args.first().copied().unwrap_or("")))
}

/// `signStaged`: macOS + Mach-O only. Always returns; failures are logged, not thrown.
pub fn sign_staged(path: &Path) -> bool {
    if !cfg!(target_os = "macos") || !is_macho(path) {
        return false;
    }
    let signed = (|| {
        let hash = find_identity().ok_or_else(|| {
            format!("Local signing identity missing; run bun scripts/sign-local.ts --create-identity once.")
        })?;
        let file = path
            .to_str()
            .ok_or_else(|| "non-UTF-8 executable path".to_owned())?;
        let requirement = format!(
            "=designated => identifier \"{SIGNING_IDENTIFIER}\" and certificate leaf = H\"{hash}\""
        );
        checked(
            "/usr/bin/codesign",
            &[
                "-f",
                "-s",
                &hash,
                "-i",
                SIGNING_IDENTIFIER,
                "--options",
                "0",
                "-r",
                &requirement,
                file,
            ],
            15,
        )?;
        checked("/usr/bin/codesign", &["--verify", "--strict", file], 15)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = signed {
        eprintln!(
            "pacer: could not sign the update as {SIGNING_IDENTIFIER} ({error}); macOS may ask for removable-volume access again."
        );
        return false;
    }
    true
}
