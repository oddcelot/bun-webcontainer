// The .astro components are shipped as they are; consumers resolve them with Astro's tooling. Here they only need to exist.
declare module "*.astro" {
  const component: (props: any) => any;
  export default component;
}
