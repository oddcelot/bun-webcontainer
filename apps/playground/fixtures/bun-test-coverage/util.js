export function never() {
  console.log("never");
  return 1;
}

export function once() {
  return 2;
}

export const obj = {
  get value() {
    return 1;
  },
  method() {
    return 2;
  },
};
