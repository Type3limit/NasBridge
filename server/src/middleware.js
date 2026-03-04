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
