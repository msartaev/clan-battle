import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
  server: { port: 5173 },
  preview: { port: 4173, host: "127.0.0.1" },
});
