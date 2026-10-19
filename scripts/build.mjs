import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension");
const dist = path.join(root, "dist");
const excluded = new Set(["_preview", "_preview.html", ".DS_Store"]);

function assertSafeDist(target) {
  const resolved = path.resolve(target);
  if (resolved !== path.join(root, "dist")) {
    throw new Error(`Refusing to clean unexpected dist path: ${resolved}`);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(fromPath, toPath);
    else if (entry.isFile()) fs.copyFileSync(fromPath, toPath);
  }
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else files.push(full);
  }
  return files;
}

function validate() {
  const manifestPath = path.join(dist, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("dist/manifest.json is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) throw new Error("Expected Manifest V3");

  const required = new Set();
  const add = (value) => {
    if (typeof value === "string") required.add(value);
  };
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon);
  for (const icon of Object.values(manifest.icons || {})) add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }

  for (const relative of required) {
    if (!fs.existsSync(path.join(dist, relative))) {
      throw new Error(`Manifest references missing file: ${relative}`);
    }
  }

  const files = walkFiles(dist);
  for (const file of files.filter((file) => file.endsWith(".js"))) {
    if (!fs.readFileSync(file, "utf8").trim()) {
      throw new Error(`Empty script: ${path.relative(dist, file)}`);
    }
  }

  return { manifest, files };
}

assertSafeDist(dist);
fs.rmSync(dist, { recursive: true, force: true });
copyDir(source, dist);

const { manifest, files } = validate();
const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(`RollGuard v${manifest.version} built`);
console.log(`Output: ${dist}`);
console.log(`Extension ID: kineplmeknglecafelokienfjelmohpg`);
console.log(`Files: ${files.length} · ${(totalBytes / 1024).toFixed(1)} KiB`);
for (const file of files.map((file) => path.relative(dist, file)).sort()) {
  console.log(`  ${file}`);
}
