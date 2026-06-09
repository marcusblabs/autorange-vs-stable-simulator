import { defineConfig } from 'vite';

// Relative base so the built bundle works both at a domain root and under a
// GitHub Pages project path (username.github.io/repo/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2020', // BigInt + balancer-maths
    outDir: 'dist',
  },
});
