// fs.cp's folders and options: what Nuxt's dev server (Nitro) leans on.
import fs from "node:fs";
import type { Case } from "./cases.ts";

export async function fsPathCases(t: Case) {
  const root = "cp-cases";
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/a/b`, { recursive: true });
  fs.writeFileSync(`${root}/a/b/x.json`, "{}");
  const at = (p: string) => `${root}/${p}`;
  // cp makes the folders its copy goes in; copyFile doesn't.
  let promised = "";
  await fs.promises.cp(at("a/b/x.json"), at("out/deep/n/x.json")).then(() => (promised = "copied"), (e: Error & { code?: string }) => (promised = `threw ${e.code}`));
  t("fs.promises.cp into a missing folder", () => [promised, fs.existsSync(at("out/deep/n/x.json"))].join());
  t("fs.cpSync into a missing folder", () => (fs.cpSync(at("a/b/x.json"), at("out2/x.json")), fs.readFileSync(at("out2/x.json"), "utf8")));
  t("fs.copyFileSync into a missing folder", () => fs.copyFileSync(at("a/b/x.json"), at("out3/y/x.json")));
  t("fs.cpSync a folder into a missing one", () => (fs.cpSync(at("a"), at("out5/q"), { recursive: true }), fs.readdirSync(at("out5/q/b"))));
  fs.writeFileSync(at("out2/x.json"), "kept");
  t("fs.cpSync force: false over a file", () => (fs.cpSync(at("a/b/x.json"), at("out2/x.json"), { force: false }), fs.readFileSync(at("out2/x.json"), "utf8")));
  t("fs.cpSync force: false, errorOnExist", () => fs.cpSync(at("a/b/x.json"), at("out2/x.json"), { force: false, errorOnExist: true }));
  t("fs.cpSync force: true over a file", () => (fs.cpSync(at("a/b/x.json"), at("out2/x.json")), fs.readFileSync(at("out2/x.json"), "utf8")));
  fs.rmSync(root, { recursive: true, force: true });

}
