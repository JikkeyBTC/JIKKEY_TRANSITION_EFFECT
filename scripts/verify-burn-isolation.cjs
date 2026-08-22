'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FORBIDDEN_MODULE_MARKERS = [
  '/src/jelly-toggle-3d/',
  '/node_modules/typegpu/',
  '/node_modules/@typegpu/',
  '/node_modules/wgpu-matrix/',
];

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function readJson(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map(normalizePath);
}

function findBurnEntry(manifest) {
  const matches = Object.entries(manifest).filter(([key, value]) => {
    if (!value || typeof value !== 'object' || value.isEntry !== true) return false;
    const normalizedKey = normalizePath(key);
    const normalizedSource = typeof value.src === 'string' ? normalizePath(value.src) : '';
    return normalizedKey === 'index.html' || normalizedSource === 'index.html';
  });

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one burn index.html manifest entry, found ${matches.length}`);
  }
  return matches[0];
}

function verifyBurnIsolation(buildDirectory) {
  const manifestPath = path.join(buildDirectory, '.vite', 'manifest.json');
  const provenancePath = path.join(buildDirectory, '.vite', 'module-provenance.json');
  const manifest = requireRecord(readJson(manifestPath), 'Vite manifest');
  const provenance = requireRecord(readJson(provenancePath), 'Module provenance');
  const [, burnEntry] = findBurnEntry(manifest);

  if (typeof burnEntry.file !== 'string') {
    throw new Error('Burn index.html manifest entry has no output file');
  }

  const manifestByFile = new Map();
  for (const [manifestKey, rawEntry] of Object.entries(manifest)) {
    if (!rawEntry || typeof rawEntry !== 'object' || typeof rawEntry.file !== 'string') continue;
    manifestByFile.set(normalizePath(rawEntry.file), { manifestKey, entry: rawEntry });
  }

  const pending = [normalizePath(burnEntry.file)];
  const visited = new Set();
  const missingProvenance = new Set();
  let moduleCount = 0;

  const enqueueManifestReferences = (entry, sourceChunk) => {
    for (const field of ['imports', 'dynamicImports']) {
      const references = entry[field] === undefined
        ? []
        : stringArray(entry[field], `Manifest ${sourceChunk} ${field}`);
      for (const reference of references) {
        const referencedEntry = manifest[reference];
        if (!referencedEntry || typeof referencedEntry !== 'object' || typeof referencedEntry.file !== 'string') {
          throw new Error(`Manifest ${sourceChunk} references missing ${field} entry ${reference}`);
        }
        pending.push(normalizePath(referencedEntry.file));
      }
    }
  };

  enqueueManifestReferences(burnEntry, 'index.html');

  while (pending.length > 0) {
    const fileName = pending.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    visited.add(fileName);

    const rawChunk = provenance[fileName];
    if (!rawChunk || typeof rawChunk !== 'object' || Array.isArray(rawChunk)) {
      missingProvenance.add(fileName);
      continue;
    }

    const modules = stringArray(rawChunk.modules, `Provenance ${fileName} modules`);
    const imports = stringArray(rawChunk.imports, `Provenance ${fileName} imports`);
    const dynamicImports = stringArray(
      rawChunk.dynamicImports,
      `Provenance ${fileName} dynamicImports`,
    );
    moduleCount += modules.length;

    for (const moduleId of modules) {
      const lowerModuleId = moduleId.toLowerCase();
      const marker = FORBIDDEN_MODULE_MARKERS.find((candidate) => lowerModuleId.includes(candidate));
      if (marker !== undefined) {
        throw new Error(`Forbidden burn dependency in ${fileName}: ${moduleId} (matched ${marker})`);
      }
    }

    pending.push(...imports, ...dynamicImports);
    const manifestRecord = manifestByFile.get(fileName);
    if (manifestRecord !== undefined) {
      enqueueManifestReferences(manifestRecord.entry, manifestRecord.manifestKey);
    }
  }

  if (missingProvenance.size > 0) {
    throw new Error(
      `Reachable burn chunks have no provenance record: ${[...missingProvenance].sort().join(', ')}`,
    );
  }

  return { chunks: visited.size, modules: moduleCount };
}

function main() {
  const buildDirectory = path.resolve(process.argv[2] ?? 'dist-renderer');
  const result = verifyBurnIsolation(buildDirectory);
  process.stdout.write(
    `Burn bundle isolation verified: ${result.chunks} chunks, ${result.modules} modules.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Burn bundle isolation failed: ${message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyBurnIsolation };
