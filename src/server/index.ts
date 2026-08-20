import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { router } from "./routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  app.use("/api", router);
  app.use(express.static(publicDir));

  // Base44 hosting is SPA-only and this mirrors that: anything that isn't an
  // API route or a static asset falls through to index.html so client-side
  // routing works on a hard refresh.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((req, res) => {
    res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
  });

  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = typeof err?.status === "number" ? err.status : 500;
    if (status >= 500) console.error(err);
    // multer's own error for an oversized upload.
    const message =
      err?.code === "LIMIT_FILE_SIZE"
        ? "That file is larger than the 10 MB upload limit."
        : err?.message ?? "Unexpected server error";
    res.status(status).json({ error: message });
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => {
    console.log(`Resume evaluator listening on http://localhost:${port}`);
  });
}
