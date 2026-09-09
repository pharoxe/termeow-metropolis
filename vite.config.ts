import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // The proxy target is the server's own PORT (server/config.ts reads the same name), not a second knob for it: a
  // developer who sets only PORT, which is what .env.example documents, would otherwise proxy to a dead 9300.
  const apiPort = env.PORT || "9300";
  const webPort = Number(env.WEB_PORT || 5174);
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${apiPort}` }
    },
    build: { sourcemap: true }
  };
});
