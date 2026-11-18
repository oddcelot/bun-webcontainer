// Loaded with `import()`: Elysia takes the module's default export once it resolves.
import { Elysia } from "elysia";

export default new Elysia({ name: "lazy" }).get("/lazy", () => "lazy plugin");
