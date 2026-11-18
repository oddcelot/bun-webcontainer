"use strict";
function used(x) {
  if (x > 0) {
    return x + 1;
  }
  return 0;
}
function unused() {
  return 1;
}
module.exports = { used, unused };
