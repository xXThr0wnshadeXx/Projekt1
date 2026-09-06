import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packageExtension } from "./package.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const downloadPath = "/downloads/orbit-network-mapper.zip";
const requestedPort = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8770;
const mimeTypes = new Map([
  [".css", "text/css"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".zip", "application/zip"], [".ttf", "font/ttf"],
]);

packageExtension();
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const requested = pathname === downloadPath
      ? join(root, "dist", "orbit-network-mapper.zip")
      : join(root, pathname === "/" ? "index.html" : pathname.slice(1));
    const file = normalize(requested);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error("Invalid path");
    if (!statSync(file).isFile()) throw new Error("Not found");
    response.statusCode = 200;
    response.setHeader("Content-Type", mimeTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream");
    if (pathname === downloadPath) {
      response.setHeader("Content-Disposition", 'attachment; filename="orbit-network-mapper.zip"');
      response.setHeader("Cache-Control", "no-store");
    }
    createReadStream(file).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  console.log(`Orbit preview: http://127.0.0.1:${address.port}`);
});
process.on("SIGINT", () => server.close());
