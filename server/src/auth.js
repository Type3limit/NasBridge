import jwt from "jsonwebtoken";

const USER_TOKEN_EXPIRES_IN = "7d";
const CLIENT_TOKEN_EXPIRES_IN = "14d";

export function signUserToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
      type: "user"
    },
    process.env.JWT_SECRET,
    { expiresIn: USER_TOKEN_EXPIRES_IN }
  );
}

export function signClientToken(client) {
  return jwt.sign(
    {
      sub: client.id,
      role: "client",
      name: client.name,
      type: "client"
    },
    process.env.JWT_SECRET,
    { expiresIn: CLIENT_TOKEN_EXPIRES_IN }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

export function extractTokenFromHeader(authorization) {
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.substring("Bearer ".length);
}
