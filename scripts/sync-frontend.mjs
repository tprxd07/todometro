import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'dist');
const files = ['index.html', 'styles.css', 'app.js'];

await mkdir(output, { recursive: true });

for (const file of files) {
  await copyFile(join(root, file), join(output, file));
}

console.log(`Frontend copiado a ${output}`);
