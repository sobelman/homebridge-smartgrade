// Copies the static custom-UI files next to the compiled UI server.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/homebridge-ui/public', { recursive: true });
cpSync('homebridge-ui/public', 'dist/homebridge-ui/public', { recursive: true });
