import { useResolvedP2PAssetUrl } from "./p2pAsset";

function getInitials(name = "") {
  const text = String(name || "").trim();
  if (!text) {
    return "NA";
  }
  const parts = text.split(/\s+/).slice(0, 2);
  return parts.map((item) => item[0]?.toUpperCase() || "").join("");
}

export default function AvatarFace({
  className,
  displayName,
  avatarUrl = "",
  avatarClientId = "",
  avatarPath = "",
  avatarFileId = "",
  p2p,
  previewUrl = "",
  decorative = true
}) {
  const resolvedUrl = useResolvedP2PAssetUrl({
    directUrl: previewUrl,
    url: avatarUrl,
    clientId: avatarClientId,
    path: avatarPath,
    fileId: avatarFileId,
    p2p
  });
  const label = displayName || "用户头像";

  return (
    <div className={className} aria-hidden={decorative ? "true" : undefined}>
      {resolvedUrl ? <img src={resolvedUrl} alt={decorative ? "" : label} /> : <span>{getInitials(displayName)}</span>}
    </div>
  );
}