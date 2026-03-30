export function parseJsonText(text = "") {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

export function parseJsonLines(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}