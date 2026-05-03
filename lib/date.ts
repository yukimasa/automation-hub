const TZ = "Asia/Tokyo";

function formatJST(date: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

export function getYesterdayJST(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return formatJST(yesterday);
}

export function getTodayJST(): string {
  return formatJST(new Date());
}

export function getJSTISOString(): string {
  const now = new Date();
  // UTC時刻に+9hしてISO文字列に変換し、ZをJSTオフセットに置換
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("Z", "+09:00");
}

export function getLastWeekRangeJST(): { start: string; end: string } {
  const todayJST = formatJST(new Date());
  const [y, m, d] = todayJST.split("-").map(Number);
  const todayDate = new Date(Date.UTC(y, m - 1, d));
  const dow = todayDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const thisMondayMs = todayDate.getTime() - daysFromMonday * 86400000;
  const lastMondayMs = thisMondayMs - 7 * 86400000;
  const lastSundayMs = lastMondayMs + 6 * 86400000;
  return {
    start: formatJST(new Date(lastMondayMs)),
    end: formatJST(new Date(lastSundayMs)),
  };
}
