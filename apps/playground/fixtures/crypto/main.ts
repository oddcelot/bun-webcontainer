// Prints cases.ts's lines with this runtime's node:crypto: native Bun for the expected output, the playground for the
// actual (scripts/crypto.ts compares them).
import crypto from "node:crypto";
import { chacha, run } from "./cases.ts";

for (const line of run(crypto)) console.log(line);
console.log(chacha(crypto));
