import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  build: {
    // Inlined data: URLs would be blocked by `img-src 'self'` in the CSP.
    assetsInlineLimit: 0,
  },
});
