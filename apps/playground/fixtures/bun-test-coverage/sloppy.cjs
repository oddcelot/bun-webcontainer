// No "use strict" of its own: its generators have theirs.
function* strictGen(a) {
  "use strict";
  yield a;
}
function* strictGenNever(a) {
  "use strict";
  yield a;
}
const strictExpr = function* (a, b) {
  "use strict";
  yield a + b;
};
module.exports = { strictGen, strictGenNever, strictExpr };
