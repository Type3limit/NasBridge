import { extractTokenFromHeader, verifyToken } from "./auth.js";

export function requireAuth(req, res, next) {
  try {
    const token = extractTokenFromHeader(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const payload = verifyToken(token);
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    return next();
  };
}

// For stream proxy routes: a normal user token in the header, or a media token in ?st=.
export function requireAuthOrMediaToken(req, res, next) {
  if (req.headers.authorization) {
    return requireAuth(req, res, next);
  }
  try {
    const payload = verifyToken(String(req.query.st || ""));
    if (payload.type !== "media") {
      return res.status(401).json({ message: "Unauthorized" });
    }
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
