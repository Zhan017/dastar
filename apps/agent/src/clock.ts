/** What a clock at the venue reads at `instant`: the weekday, the date and time to the minute, and the offset from UTC ("+01:00"). */
export function venueClock(instant: string, timezone: string): { weekday: string; local: string; offset: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(instant));

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) throw new Error(`no ${type} in the time at ${timezone}`);
    return found.value;
  };

  // "GMT+01:00", "GMT-03:30" (some runtimes write the minus as U+2212), and "GMT" alone for UTC
  const zone = part("timeZoneName").replace("−", "-").replace(/^GMT/, "");
  return {
    weekday: part("weekday"),
    local: `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`,
    offset: zone === "" ? "+00:00" : zone,
  };
}
