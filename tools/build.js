import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageExtension } from "./package.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["--check", join(root, "src", "app.js")]);
const extensionZip = packageExtension();
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(join(out, "src"), { recursive: true });
mkdirSync(join(out, "downloads"), { recursive: true });

for (const name of ["index.html", "setup.html", "map.html", "styles.css"]) {
  copyFileSync(join(root, name), join(out, name));
}
for (const name of ["app.js", "core.js", "graph.js", "companion.js", "library.js", "onboarding.js", "workspace.js", "filters.js"]) {
  copyFileSync(join(root, "src", name), join(out, "src", name));
}
copyFileSync(extensionZip, join(out, "downloads", "orbit-network-mapper.zip"));

const hosting = JSON.parse(readFileSync(join(root, ".openai", "hosting.json"), "utf8"));
if (hosting.d1 !== "DB") throw new Error('.openai/hosting.json must bind D1 as "DB"');
console.log("Static app and Chrome companion built in out/.");

const mimeTypes = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".zip", "application/zip"],
]);
const assets = {};
const pending = [out];
while (pending.length) {
  const directory = pending.pop();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pending.push(path);
    else {
      const extension = extname(entry.name).toLowerCase();
      const binary = extension === ".zip";
      assets[`/${relative(out, path).replaceAll("\\", "/")}`] = {
        body: binary ? readFileSync(path).toString("base64") : readFileSync(path, "utf8"),
        binary,
        type: mimeTypes.get(extension) ?? "application/octet-stream",
      };
    }
  }
}
mkdirSync(join(root, ".build"), { recursive: true });
writeFileSync(join(root, ".build", "assets.js"), `export default ${JSON.stringify(assets)};`, "utf8");

run(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build"]);
