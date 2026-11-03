// Types for the Starlight virtual modules that Starlight's own components import. tsc checks those
// .astro files as source (via @astrojs/ts-content-mapper), but Starlight doesn't publish these declarations.
declare module "virtual:starlight/user-config" {
  const config: import("@astrojs/starlight/types").StarlightConfig;
  export default config;
}

declare module "virtual:starlight/user-images" {
  export const logos: { dark?: import("astro").ImageMetadata; light?: import("astro").ImageMetadata };
}

// The overridable components Footer.astro (src/components/Footer.astro wraps it) renders.
declare module "virtual:starlight/components/EditLink" {
  const Component: (props: Record<string, never>) => unknown;
  export default Component;
}
declare module "virtual:starlight/components/LastUpdated" {
  const Component: (props: Record<string, never>) => unknown;
  export default Component;
}
declare module "virtual:starlight/components/Pagination" {
  const Component: (props: Record<string, never>) => unknown;
  export default Component;
}
