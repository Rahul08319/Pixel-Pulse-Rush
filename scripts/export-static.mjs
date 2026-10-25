import fs from "fs";
import path from "path";

async function exportStatic() {
  console.log("Generating static files for GitHub Pages...");

  const ssrPath = path.resolve(".output/server/_ssr/ssr.mjs");
  if (!fs.existsSync(ssrPath)) {
    throw new Error("SSR build not found! Run 'npm run build' first.");
  }

  const { default: ssr } = await import(`file://${ssrPath.replace(/\\/g, "/")}`);
  const res = await ssr.fetch(new Request("http://localhost/"));
  let html = await res.text();

  // Adjust asset paths to work relative to any base path or repo subfolder
  html = html.replace(/href="\/assets\//g, 'href="./assets/');
  html = html.replace(/src="\/assets\//g, 'src="./assets/');
  html = html.replace(/"\/assets\//g, '"./assets/');

  const distDir = path.resolve("dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Copy assets folder from .output/public/assets to dist/assets
  const srcAssetsDir = path.resolve(".output/public/assets");
  const destAssetsDir = path.resolve(distDir, "assets");
  if (!fs.existsSync(destAssetsDir)) {
    fs.mkdirSync(destAssetsDir, { recursive: true });
  }

  const assetFiles = fs.readdirSync(srcAssetsDir);
  for (const file of assetFiles) {
    fs.copyFileSync(path.resolve(srcAssetsDir, file), path.resolve(destAssetsDir, file));
  }

  // Write index.html and 404.html (for GitHub Pages SPA routing fallback)
  fs.writeFileSync(path.resolve(distDir, "index.html"), html, "utf-8");
  fs.writeFileSync(path.resolve(distDir, "404.html"), html, "utf-8");

  // Create .nojekyll so GitHub Pages doesn't ignore files or folders with underscores
  fs.writeFileSync(path.resolve(distDir, ".nojekyll"), "", "utf-8");

  // Copy favicon.ico if it exists
  const faviconPath = path.resolve(".output/public/favicon.ico");
  if (fs.existsSync(faviconPath)) {
    fs.copyFileSync(faviconPath, path.resolve(distDir, "favicon.ico"));
  }

  console.log(`Successfully generated static build in ${distDir}!`);
  console.log("Files generated:");
  fs.readdirSync(distDir).forEach((f) => console.log(` - ${f}`));
}

exportStatic().catch((err) => {
  console.error("Export static failed:", err);
  process.exit(1);
});
