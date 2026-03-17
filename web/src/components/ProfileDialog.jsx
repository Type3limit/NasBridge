import { useEffect, useRef, useState } from "react";
import { Button, Caption1, Field, Input, Subtitle1, Text, Textarea } from "@fluentui/react-components";
import { AddRegular, DismissRegular, SaveRegular } from "@fluentui/react-icons";
import AvatarFace from "./AvatarFace";

const MAX_AVATAR_FILE_BYTES = 4 * 1024 * 1024;

export default function ProfileDialog({ open, user, p2p, saving, onClose, onSave }) {
  const fileInputRef = useRef(null);
  const [draft, setDraft] = useState({
    displayName: "",
    email: "",
    avatarUrl: "",
    bio: "",
    avatarFile: null
  });

  useEffect(() => {
    if (!open || !user) {
      return;
    }
    setDraft({
      displayName: user.displayName || "",
      email: user.email || "",
      avatarUrl: "",
      bio: user.bio || "",
      avatarFile: null
    });
  }, [open, user]);

  function handleAvatarPick(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      window.alert("头像文件不能超过 4 MB");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDraft((prev) => ({
        ...prev,
        avatarFile: file,
        avatarUrl: typeof reader.result === "string" ? reader.result : prev.avatarUrl
      }));
    };
    reader.readAsDataURL(file);
  }

  if (!open || !user) {
    return null;
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modalWindow profileDialog dialogModal" onClick={(event) => event.stopPropagation()}>
        <div className="modalHeader profileDialogHeader">
          <div>
            <Subtitle1>个人资料</Subtitle1>
            <Caption1>{user.email || "未填写邮箱"}</Caption1>
          </div>
          <Button size="small" className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="关闭个人资料" title="关闭" onClick={onClose} />
        </div>

        <div className="profileDialogStack">
          <div className="profileAvatarRow">
            <AvatarFace
              className="profileAvatarLarge"
              displayName={draft.displayName || user.displayName}
              avatarUrl={user.avatarUrl}
              avatarClientId={user.avatarClientId}
              avatarPath={user.avatarPath}
              avatarFileId={user.avatarFileId}
              previewUrl={draft.avatarFile ? draft.avatarUrl : ""}
              p2p={p2p}
            />
            <div className="profileAvatarMeta">
              <Text>{draft.displayName || "未命名用户"}</Text>
              <Caption1>{user.role === "admin" ? "管理员" : "成员"}</Caption1>
              <Caption1>{draft.avatarFile ? `已选择：${draft.avatarFile.name}` : "未选择新头像时保留当前头像"}</Caption1>
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" className="hiddenInput" onChange={handleAvatarPick} />
            <Button className="dialogActionButton" icon={<AddRegular />} onClick={() => fileInputRef.current?.click()}>上传本地头像</Button>
          </div>

          <Field className="filterField filterControl dialogField" label="显示名称">
            <Input className="filterInput dialogInput" value={draft.displayName} onChange={(_, data) => setDraft((prev) => ({ ...prev, displayName: data.value }))} placeholder="例如：客厅 NAS" />
          </Field>
          <Field className="filterField filterControl dialogField" label="邮箱">
            <Input className="filterInput dialogInput" value={draft.email} onChange={(_, data) => setDraft((prev) => ({ ...prev, email: data.value }))} placeholder="you@example.com" />
          </Field>
          <Field className="filterField filterControl dialogField" label="个人简介">
            <Textarea value={draft.bio} onChange={(_, data) => setDraft((prev) => ({ ...prev, bio: data.value }))} placeholder="介绍一下自己或当前设备职责" resize="vertical" />
          </Field>
        </div>

        <div className="drawerFooterInline profileDialogFooter">
          <Button className="dialogActionButton dialogIconOnlyButton" icon={<DismissRegular />} aria-label="取消" title="取消" onClick={onClose} />
          <Button className="dialogActionButton dialogPrimaryButton" appearance="primary" icon={<SaveRegular />} onClick={() => onSave(draft)} disabled={saving}>
            {saving ? "保存中..." : "保存资料"}
          </Button>
        </div>
      </div>
    </div>
  );
}