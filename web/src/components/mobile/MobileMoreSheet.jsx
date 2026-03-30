import { createPortal } from "react-dom";
import { useEffect } from "react";
import {
  ArrowRightRegular,
  ArrowSwapRegular,
  DesktopRegular,
  EditRegular,
  ShareRegular,
} from "@fluentui/react-icons";

export default function MobileMoreSheet({
  open,
  onClose,
  onNavigate,
  user,
  transferCount,
  shareCount,
  onlineClientCount,
  onLogout,
}) {
  // Body scroll lock
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Android hardware back button
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ moreSheet: true }, "");
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open, onClose]);

  function nav(id) {
    onNavigate(id);
  }

  const isAdmin = user?.role === "admin";

  return createPortal(
    <>
      <div
        className={`mobileMoreSheetBackdrop${open ? " open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`mobileMoreSheet${open ? " open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="更多选项"
      >
        <div className="mobileMoreSheetHandle" aria-hidden="true" />
        <div className="mobileMoreSheetContent">
          <button
            type="button"
            className="mobileMoreSheetRow"
            onClick={() => nav("transfers")}
          >
            <span className="mobileMoreSheetRowIcon"><ArrowSwapRegular /></span>
            <span className="mobileMoreSheetRowLabel">传输队列</span>
            {transferCount > 0 && (
              <span className="mobileMoreSheetBadge">{transferCount}</span>
            )}
          </button>

          <button
            type="button"
            className="mobileMoreSheetRow"
            onClick={() => nav("shares")}
          >
            <span className="mobileMoreSheetRowIcon"><ShareRegular /></span>
            <span className="mobileMoreSheetRowLabel">分享管理</span>
            {shareCount > 0 && (
              <span className="mobileMoreSheetBadge">{shareCount}</span>
            )}
          </button>

          <button
            type="button"
            className="mobileMoreSheetRow"
            onClick={() => nav("terminals")}
          >
            <span className="mobileMoreSheetRowIcon"><DesktopRegular /></span>
            <span className="mobileMoreSheetRowLabel">终端状态</span>
            {onlineClientCount > 0 && (
              <span className="mobileMoreSheetBadge">{onlineClientCount}</span>
            )}
          </button>

          {isAdmin && (
            <>
              <div className="mobileMoreSheetDivider" aria-hidden="true" />
              <button
                type="button"
                className="mobileMoreSheetRow"
                onClick={() => nav("admin-users")}
              >
                <span className="mobileMoreSheetRowIcon"><EditRegular /></span>
                <span className="mobileMoreSheetRowLabel">用户管理</span>
              </button>
              <button
                type="button"
                className="mobileMoreSheetRow"
                onClick={() => nav("admin-clients")}
              >
                <span className="mobileMoreSheetRowIcon"><DesktopRegular /></span>
                <span className="mobileMoreSheetRowLabel">终端管理</span>
              </button>
            </>
          )}

          <div className="mobileMoreSheetDivider" aria-hidden="true" />

          <button
            type="button"
            className="mobileMoreSheetRow mobileMoreSheetLogout"
            onClick={onLogout}
          >
            <span className="mobileMoreSheetRowIcon"><ArrowRightRegular /></span>
            <span className="mobileMoreSheetRowLabel">退出登录</span>
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
