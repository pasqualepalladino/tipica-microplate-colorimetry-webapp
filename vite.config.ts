import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/tipica-microplate-colorimetry-webapp/',
  plugins: [react()],
});
