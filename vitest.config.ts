import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // The real `obsidian` module is only available inside Obsidian at runtime.
      // Tests alias it to a lightweight mock so pure-logic modules import cleanly.
      obsidian: path.resolve(__dirname, "test/obsidian-mock.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
