---
title: "Bun.password example: hash and verify passwords"
description: "Hash a password with Bun.password (argon2id or bcrypt) and verify it, with no package to install, in a runnable example in your browser."
sidebar:
  order: 6
  label: Bun.password
---

`Bun.password` hashes and verifies passwords with argon2id, argon2i, argon2d or bcrypt, built into Bun. Press **Run** to hash a password and check two guesses against it.

```ts playground
const hash = await Bun.password.hash("correct horse battery staple");
console.log(hash);

console.log(await Bun.password.verify("correct horse battery staple", hash)); // true
console.log(await Bun.password.verify("Tr0ub4dor&3", hash)); // false

const bcrypt = await Bun.password.hash("hunter2", { algorithm: "bcrypt", cost: 10 });
console.log(bcrypt.slice(0, 7), await Bun.password.verify("hunter2", bcrypt));
```

## How it works

- **`Bun.password.hash(password)`** uses argon2id by default and returns a string in the standard PHC format, which carries the algorithm, its settings and a random salt. Store that string as it is.
- **`Bun.password.verify(password, hash)`** reads the algorithm from the hash, so it checks argon2 and bcrypt hashes alike.
- **Options** pick the algorithm and its cost: `{ algorithm: "argon2id", memoryCost, timeCost }` or `{ algorithm: "bcrypt", cost }`.
- **`hashSync` and `verifySync`** do the same without a promise, blocking until they finish.

Each call to `hash` produces a different string for the same password, because of the salt. That's expected: compare with `verify`, never with `===`.

## In the playground

The hashing runs in WebAssembly builds of the argon2 and bcrypt reference code, in your browser. See [Bun APIs](/compatibility/bun/).
