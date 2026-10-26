import { join, relative, resolve, sep } from "node:path";
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
  if (credentialTrees.some((part) => contains(join(home, part), path)))
    return true;
  return /(?:^|\/)(?:credentials?[^/]*|auth\.json|authInfo|cli-config\.json|\.credentials\.json|\.claude\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|state\.vscdb|storage\.json)(?:\/|$)/i.test(
    path,
  );
}
