import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss(), jsxLocPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "framework";
          if (/\/node_modules\/(?:@wizardconnect|nostr-tools)\//.test(id)) return "wallet-connect";
          if (/\/node_modules\/(?:@stellar)\//.test(id)) return "stellar";
          if (/\/node_modules\/@bitauth\//.test(id)) return "libauth";
          if (/\/node_modules\/(?:@mr-zwets|cashc|cashscript)\//.test(id)) return "bitcoin-cash";
          if (/\/node_modules\/(?:@radix-ui)\//.test(id)) return "ui-primitives";
          if (id.includes("/node_modules/lucide-react/")) return "icons";
          if (/\/node_modules\/(?:@trpc|@tanstack)\//.test(id)) return "data-client";
          return "vendor";
        },
      },
    },
  },
  server: {
    host: true,
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: { strict: true, deny: ["**/.*"] },
  },
});
