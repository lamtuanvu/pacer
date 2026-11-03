import { join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { Ctx } from "../types";
const contains = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
/** Native credential stores and host control state are never installation sources. */
export function plannerPrivatePath(
  ctx: Pick<Ctx, "home" | "pacerHome">,
  raw: string,
): boolean {
  const path = resolve(raw),
    home = resolve(ctx.home),
    privateRoot = resolve(ctx.pacerHome);
  const folded = (value: string) => process.platform === "darwin" ? value.toLowerCase() : value;
  const canonical = (() => { try { return realpathSync(path); } catch { return path; } })();
  if (contains(folded(path), folded(home)) || contains(folded(canonical), folded(home))) return true;
  const privateEntry = contains(privateRoot, path)
    ? relative(privateRoot, path).split(sep)[0]
    : undefined;
  if (
    path === privateRoot ||
    (privateEntry !== undefined &&
      [
        "secrets",
        "state",
        "cache",
        "logs",
        "plugins",
        "install-locks",
        "locks",
        "endpoints",
        "ssh",
        "link",
        "orca",
        "orca-plugin",
        "worktrees",
        "runs",
        "token",
        "strategy.yaml",
        "activity.lock",
        "activity.json",
        "orca.json",
        "plugin-version.json",
        "plugin-live.json",
        "install-manifest.json",
        "install-transaction.json",
      ].includes(privateEntry))
  )
    return true;
  const credentialTrees = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".config/arkcli",
    ".ark",
    ".local/share/keyrings",
    "Library/Keychains",
    "Library/Application Support/Cursor/User/globalStorage",
    ".config/Cursor/User/globalStorage",
  ];
  if (credentialTrees.some((part) => contains(folded(join(home, part)), folded(path)) || contains(folded(join(home, part)), folded(canonical))))
    return true;
  return /(?:^|\/)(?:credentials?[^/]*|auth\.json|authInfo|cli-config\.json|\.credentials\.json|\.claude\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|state\.vscdb|storage\.json)(?:\/|$)/i.test(
    path,
  );
}
