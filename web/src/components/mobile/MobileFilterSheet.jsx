import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "@fluentui/react-components";

const TYPE_OPTIONS = [
  { value: "all",   label: "全部类型" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "doc",   label: "文档" },
  { value: "other", label: "其他" },
];

const SORT_OPTIONS = [
  { value: "createdAt", label: "按上传时间" },
  { value: "name",      label: "按文件名" },
  { value: "type",      label: "按类型" },
];

const DEFAULTS = { keyword: "", columnFilter: "all", typeFilter: "all", sortBy: "createdAt" };

export default function MobileFilterSheet({
  open,
  onClose,
  keyword,
  columnFilter,
  typeFilter,
  sortBy,
  columns = [],
  onApply,
  onReset,
}) {
  const [draft, setDraft] = useState({ keyword, columnFilter, typeFilter, sortBy });

  // Sync draft when sheet opens
  useEffect(() => {
    if (open) setDraft({ keyword, columnFilter, typeFilter, sortBy });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Android back button
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ mobileFilterSheet: true }, "");
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const isDirty = draft.keyword !== DEFAULTS.keyword || draft.columnFilter !== DEFAULTS.columnFilter || draft.typeFilter !== DEFAULTS.typeFilter || draft.sortBy !== DEFAULTS.sortBy;

  const columnOptions = [
    { value: "all", label: "全部栏目" },
    { value: "none", label: "未分类" },
    ...columns.map((c) => ({ value: c.id, label: c.name })),
  ];

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="mobileSheetBackdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Sheet */}
      <div className="mobileFilterSheet" role="dialog" aria-modal="true" aria-label="筛选与排序">
        {/* Handle */}
        <div className="mobileSheetHandle" />

        {/* Header */}
        <div className="mobileFilterSheetHeader">
          <span className="mobileFilterSheetTitle">筛选与排序</span>
          <button type="button" className="mobileSheetCloseBtn" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        {/* Body */}
        <div className="mobileFilterSheetBody">
          {/* Keyword */}
          <label className="mobileFilterLabel">搜索文件</label>
          <Input
            className="mobileFilterInput"
            value={draft.keyword}
            onChange={(_, data) => set("keyword")(data.value)}
            placeholder="搜索文件名或路径"
          />

          {/* Column */}
          <label className="mobileFilterLabel">栏目</label>
          <div className="mobileFilterChips">
            {columnOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mobileFilterChip${draft.columnFilter === opt.value ? " active" : ""}`}
                onClick={() => set("columnFilter")(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Type */}
          <label className="mobileFilterLabel">分类</label>
          <div className="mobileFilterChips">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mobileFilterChip${draft.typeFilter === opt.value ? " active" : ""}`}
                onClick={() => set("typeFilter")(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Sort */}
          <label className="mobileFilterLabel">排序方式</label>
          <div className="mobileFilterChips">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`mobileFilterChip${draft.sortBy === opt.value ? " active" : ""}`}
                onClick={() => set("sortBy")(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="mobileFilterSheetFooter">
          <button
            type="button"
            className="mobileFilterResetBtn"
            onClick={() => {
              setDraft({ ...DEFAULTS });
              onReset();
            }}
          >
            重置
          </button>
          <button
            type="button"
            className="mobileFilterApplyBtn"
            onClick={() => onApply({ ...draft })}
          >
            {isDirty ? "应用筛选" : "确认"}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
