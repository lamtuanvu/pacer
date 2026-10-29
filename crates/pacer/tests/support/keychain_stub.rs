use std::{ffi::OsString, fs, os::unix::fs::PermissionsExt, path::Path};

// Mirrors installKeychainStub in scripts/live/keychain.ts: generic passwords are files under the store.
const STUB: &str = r#"
const { existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const store = __STORE__;
const flag = (a, f) => { const i = a.indexOf(f); return i < 0 ? "" : a[i + 1] ?? ""; };
function one(a) {
  const file = require("node:path").join(store, flag(a, "-s") + "." + flag(a, "-a").replaceAll("/", "_"));
  switch (a[0]) {
    case "add-generic-password": writeFileSync(file, flag(a, "-X"), { mode: 0o600 }); return 0;
    case "find-generic-password": {
      if (!existsSync(file)) return 44;
      if (!a.includes("-w")) return 0;
      const v = Buffer.from(readFileSync(file, "utf8"), "hex");
      process.stdout.write(([...v].every(b => b >= 0x20 && b < 0x7f) ? v.toString("latin1") : v.toString("hex")) + "\n");
      return 0;
    }
    case "delete-generic-password": if (!existsSync(file)) return 44; rmSync(file); return 0;
  }
  return 1;
}
const args = process.argv.slice(2);
if (args[0] === "-i") {
  for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) { const code = one(line.split(" ")); if (code) process.exit(code); }
  process.exit(0);
}
process.exit(one(args));
"#;

/// A PATH whose first entry resolves `security` to a file-backed stub under `root`, so a spawned core never
/// writes the login Keychain. `bun` runs the stub: a path, or a name looked up on PATH.
pub fn keychain_stub_path(root: &Path, bun: &str) -> OsString {
    let bin = root.join("keychain-bin");
    let store = root.join("keychain");
    fs::create_dir_all(&bin).unwrap();
    fs::create_dir_all(&store).unwrap();
    let shebang = if bun.contains('/') {
        format!("#!{}", fs::canonicalize(bun).unwrap().display())
    } else {
        format!("#!/usr/bin/env {bun}")
    };
    let store = serde_json::to_string(&store.to_string_lossy()).unwrap();
    let script = bin.join("security");
    fs::write(
        &script,
        shebang + STUB.replace("__STORE__", &store).as_str(),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let mut path = OsString::from(&bin);
    path.push(":");
    path.push(std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()));
    path
}
