declare module "virtual:@runbun/astro/config" {
  export const config: { playgroundUrl: string; base: string; sync?: { scheme?: string; family?: string } };
  export const css: string;
}
declare module "virtual:@runbun/astro/blocks.css" {}
