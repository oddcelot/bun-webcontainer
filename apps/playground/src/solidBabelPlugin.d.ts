// Solid 2's Babel plugin ships no types; fastPath.ts hands it to @babel/standalone as is.
declare module "@solidjs/babel-plugin" {
  const plugin: (api: object, options: object, dirname: string) => { name?: string; visitor: {} };
  export default plugin;
}
