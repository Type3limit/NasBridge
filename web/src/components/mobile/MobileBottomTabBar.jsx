import {
  AppsListRegular,
  ChatRegular,
  FolderOpenRegular,
  MoreHorizontalRegular,
  StreamRegular,
} from "@fluentui/react-icons";

const TABS = [
  { id: "explorer", label: "文件", icon: <FolderOpenRegular /> },
  { id: "chat",     label: "聊天", icon: <ChatRegular /> },
  { id: "overview", label: "概览", icon: <AppsListRegular /> },
  { id: "tv",       label: "直播", icon: <StreamRegular /> },
  { id: "more",     label: "更多", icon: <MoreHorizontalRegular /> },
];

export default function MobileBottomTabBar({
  activeTab,
  moreSheetOpen,
  onTabChange,
  explorerBadge,
  moreBadge,
}) {
  function isActive(id) {
    if (id === "more") return moreSheetOpen || activeTab === "more";
    return activeTab === id && !moreSheetOpen;
  }

  const badgeMap = { explorer: explorerBadge, more: moreBadge };

  return (
    <nav className="mobileBottomTabBar" aria-label="主导航">
      {TABS.map((tab) => {
        const badge = badgeMap[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            className={`mobileTabItem${isActive(tab.id) ? " active" : ""}`}
            onClick={() => onTabChange(tab.id)}
            aria-label={tab.label}
            aria-current={isActive(tab.id) ? "page" : undefined}
          >
            <span className="mobileTabIcon" aria-hidden="true">{tab.icon}</span>
            <span className="mobileTabLabel">{tab.label}</span>
            {badge && <span className="mobileTabBadge" aria-label={`${badge} 项`}>{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}
