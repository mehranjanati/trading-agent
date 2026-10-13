// vite.config.ts — E10-T01-S1
// Tailwind 4 via the official Vite plugin (shadcn-svelte requirement).
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});