use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

/// Bound both elapsed time and output, including when a descendant retains stdout.
pub(super) fn output(program: &Path, args: &[&str], seconds: u64) -> Option<Vec<u8>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    runtime.block_on(async {
        let mut child = Command::new(program)
            .args(args)
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

pub(super) fn sign(path: &Path) -> Result<(), super::RepairError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    // Metadata lookup for pacer's own signing identity; no planner/executor credentials.
    let bytes = output(
        Path::new("/usr/bin/security"),
        &["find-identity", "-v", "-p", "codesigning"],
        3,
    )
    .ok_or_else(|| super::RepairError::Invalid("cannot inspect local signing identities".into()))?;
    let text = String::from_utf8_lossy(&bytes);
    let identity = text.lines().find_map(|line| {
        let words: Vec<_> = line.split_whitespace().collect();
        let hash = *words.get(1)?;
        (line.trim_end().ends_with("\"pacer local code signing\"")
            && hash.len() == 40
            && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(hash)
    });
    let Some(hash) = identity else {
        return Ok(());
    };
    // Only native Mach-O files need signing; scripts are useful for fixture smoke tests.
    use std::io::Read;
    let mut magic = [0; 4];
    if std::fs::File::open(path)?.read_exact(&mut magic).is_err()
        || !matches!(
            u32::from_be_bytes(magic),
            0xfeedface | 0xfeedfacf | 0xcefaedfe | 0xcffaedfe | 0xcafebabe | 0xbebafeca
        )
    {
        return Ok(());
    }
    let requirement =
        format!("=designated => identifier \"dev.pacer.cli\" and certificate leaf = H\"{hash}\"");
    let file = path
        .to_str()
        .ok_or_else(|| super::RepairError::Invalid("non-UTF-8 executable path".into()))?;
    output(
        Path::new("/usr/bin/codesign"),
        &[
            "-f",
            "-s",
            hash,
            "-i",
            "dev.pacer.cli",
            "--options",
            "0",
            "-r",
            &requirement,
            file,
        ],
        15,
    )
    .ok_or_else(|| super::RepairError::Invalid("local code signing failed".into()))?;
    output(
        Path::new("/usr/bin/codesign"),
        &["--verify", "--strict", file],
        15,
    )
    .ok_or_else(|| super::RepairError::Invalid("code signature verification failed".into()))?;
    Ok(())
}
