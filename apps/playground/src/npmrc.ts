/**
 * The project's `.npmrc` (the file next to package.json, nothing else: not the home folder's, not the environment): the
 * registries `bun install` fetches from, and the credentials it sends to them.
 *
 *   registry=https://registry.example.com/
 *   @scope:registry=https://npm.pkg.example.com/
 *   //npm.pkg.example.com/:_authToken=<token>
 *   //registry.example.com/:_auth=<base64 of user:password>
 *
 * A value with `${VAR}` in it needs an environment, which the browser has none of: that line is skipped, and
 * reported in `warnings`.
 */
export type Npmrc = {
  /** `registry=`, without a trailing slash. */
  registry?: string;
  /** `@scope:registry=` by scope (`@scope`), without a trailing slash. */
  scopes: Record<string, string>;
  /** Credentials by the `//host/path/` they are for. */
  auth: { prefix: string; header: string }[];
  warnings: string[];
};

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const trim = (url: string) => url.replace(/\/+$/, "");

export function parseNpmrc(text: string | undefined): Npmrc {
  const out: Npmrc = { scopes: {}, auth: [], warnings: [] };
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (value.includes("${")) {
      out.warnings.push(`.npmrc: ${key} uses an environment variable, which the browser doesn't have`);
      continue;
    }
    if (key === "registry") {
      if (/^https?:\/\//.test(value)) out.registry = trim(value);
      else out.warnings.push(`.npmrc: registry must be an http(s) URL`);
      continue;
    }
    const scope = /^(@[^:]+):registry$/.exec(key);
    if (scope) {
      if (/^https?:\/\//.test(value)) out.scopes[scope[1]] = trim(value);
      else out.warnings.push(`.npmrc: ${key} must be an http(s) URL`);
      continue;
    }
    const cred = /^(\/\/.+\/):(_authToken|_auth)$/.exec(key);
    if (cred && value) out.auth.push({ prefix: cred[1], header: `${cred[2] === "_authToken" ? "Bearer" : "Basic"} ${value}` });
  }
  return out;
}

/** The registry `name` comes from: its scope's, else the default one, else npm's. No trailing slash. */
export function registryFor(rc: Npmrc, name: string): string {
  const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
  return (scope && rc.scopes[scope]) || rc.registry || DEFAULT_REGISTRY;
}

/** The `Authorization` value for a URL: the credentials of the longest `//host/path/` prefix it falls under, if any. */
export function authFor(rc: Npmrc, url: string): string | undefined {
  const bare = url.replace(/^https?:/, "");
  let best: { prefix: string; header: string } | undefined;
  for (const a of rc.auth) if (bare.startsWith(a.prefix) && (!best || a.prefix.length > best.prefix.length)) best = a;
  return best?.header;
}
