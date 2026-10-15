import path from "node:path";
import express from "express";
import compression from "compression";

// Mount after API routes so streaming APIs and media keep their own behavior.
export function frontendMiddleware(webDist) {
  const router = express.Router();
  router.use(compression({ threshold: 1024 }));
  router.use(express.static(webDist, {
    setHeaders(res, filePath) {
      const relativePath = path.relative(webDist, filePath).split(path.sep).join("/");
      if (/^assets\/.+-[\w-]{8,}\.[\w]+$/.test(relativePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  }));
  return router;
}
