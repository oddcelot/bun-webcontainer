// Node's `assert`, as far as @babel/helper-module-imports (under @solidjs/babel-plugin, the fast path's Solid 2 JSX) uses it.
module.exports = function assert(value, message) {
  if (!value) throw new Error(message || "Assertion failed");
};
