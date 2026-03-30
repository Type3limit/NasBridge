function pad2(value) {
  return String(value).padStart(2, "0");
}

function getWeekdayLabel(day = 0) {
  return ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][day] || "";
}

export function getRealtimeContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return {
    now,
    timezone,
    isoUtc: now.toISOString(),
    localDate,
    localTime,
    localDateTime: `${localDate} ${localTime}`,
    weekday: getWeekdayLabel(now.getDay())
  };
}

export function buildRealtimeContextText() {
  const info = getRealtimeContext();
  return [
    "实时信息：",
    `- 当前本地日期：${info.localDate}`,
    `- 当前本地时间：${info.localTime}`,
    `- 当前星期：${info.weekday}`,
    `- 当前时区：${info.timezone}`,
    `- 当前 UTC 时间：${info.isoUtc}`,
    "如果用户提到今天、当前、最近、本周、本月等时间词，以上实时信息优先生效，不要假设自己处于其他日期。"
  ].join("\n");
}