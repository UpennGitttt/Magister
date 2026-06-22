import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.MAGISTER_DB_PATH ?? ".local/control-plane.sqlite",
  },
});
