// Petit serveur local pour tester le site : node tools/serve.js puis http://localhost:5173
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  const p = path.normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^([\/]\.\.)+/, "");
  const file = path.join(root, p.endsWith("/") || p === "\\" ? "index.html" : p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Introuvable"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(5173, () => console.log("http://localhost:5173"));
