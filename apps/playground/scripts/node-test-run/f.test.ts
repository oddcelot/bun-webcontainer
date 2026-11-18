// A file with a `test.only`: the other tests don't run or count, with `--only` or without.
import { test } from "bun:test";

test("not only", () => {});
test.only("the only one", () => {});
