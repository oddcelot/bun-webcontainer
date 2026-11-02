import { Elysia, sse, status, t } from "elysia";

const users = new Map([["1", { id: "1", name: "Ada" }]]);

const app = new Elysia()
  .get("/", () => "Hello from Elysia 2")
  .get("/json", () => ({ framework: "elysia", runtime: Bun.version }))
  .get("/user/:id", ({ params }) => users.get(params.id) ?? status(404, "No such user"))
  // Elysia 2 takes the hook before the handler: (path, hook, handler)
  .post("/user", { body: t.Object({ name: t.String({ minLength: 1 }) }) }, ({ body }) => {
    const user = { id: String(users.size + 1), ...body };
    users.set(user.id, user);
    return status(201, user);
  })
  .get("/count", function* () {
    for (let i = 1; i <= 3; i++) yield sse({ event: "tick", data: i });
  })
  .listen(3000);

console.log(`Elysia running at ${app.server?.url}`);
