import { ConfigError } from "../../config/load.js";
import type { Context, ContextInput, Schedule } from "../../config/schema.js";
import { CalendarError, DEFAULT_TIME, calendarOf, describeSchedule, nextRuns, parseTime, type Weekday } from "../../schedule/calendar.js";
import { type Prompter, PromptCancelled } from "../../util/prompter.js";
import { type ScheduleDeps, installSchedule } from "../schedule.js";

const WEEK: readonly Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

type ScheduleInput = NonNullable<ContextInput["schedule"]>;

/**
 * Every day or on chosen weekdays, at a time; the time zone is the machine's (or the one set
 * before), so a run on Actions keeps the same wall time. A monthly or cron schedule set by hand
 * can be kept as it is.
 */
export async function askSchedule(p: Prompter, previous: Schedule | undefined, timeZone: string): Promise<ScheduleInput> {
  const custom = previous?.interval === "monthly" || previous?.interval === "cron" ? previous : undefined;
  const choice = await p.select({
    message: "When should pochi run?",
    options: [
      { value: "daily" as const, label: "Every day" },
      { value: "weekly" as const, label: "On chosen days of the week" },
      ...(custom ? [{ value: "keep" as const, label: `Keep ${describeSchedule(custom, custom.timezone ?? timeZone)}` }] : []),
    ],
    initialValue: custom ? "keep" : previous?.interval === "weekly" ? "weekly" : "daily",
  });
  if (choice === "keep" && custom) return custom;
  // Keep is offered only with a custom schedule to keep.
  const interval = choice === "weekly" ? "weekly" : "daily";
  let days: Weekday[] = [];
  if (interval === "weekly") {
    const before = previous?.day === undefined ? ["monday" as const] : [previous.day].flat();
    for (;;) {
      days = await p.multiselect({
        message: "Days to run on (space to select)",
        options: WEEK.map((d) => ({ value: d, label: d.charAt(0).toUpperCase() + d.slice(1) })),
        initialValues: before,
      });
      if (days.length > 0) break;
      p.warn("Pick at least one day.");
    }
  }
  const time = await p.text({
    message: "Time to run (HH:MM, 24-hour)",
    placeholder: DEFAULT_TIME,
    initialValue: custom ? undefined : (previous?.time ?? DEFAULT_TIME),
    validate: validTime,
  });
  return {
    interval,
    ...(days.length > 0 && { day: days.length === 1 ? days[0] : days }),
    time: time.trim(),
    timezone: previous?.timezone ?? timeZone,
  };
}

export function validTime(value: string): string | undefined {
  try {
    parseTime(value.trim());
    return undefined;
  } catch (err) {
    if (err instanceof CalendarError) return err.message;
    throw err;
  }
}

/** Runs in the next 30 days, capped: a cron job every minute is not worth counting. */
export function runsPerMonth(schedule: Schedule, timeZone: string, now: Date): number {
  const end = now.getTime() + 30 * 86_400_000;
  return nextRuns(calendarOf(schedule), schedule.timezone ?? timeZone, now, 1000).filter((r) => r.getTime() < end).length;
}

/** Whether a setup posting to Slack runs on GitHub Actions rather than on this machine. */
export async function askWhereToRun(p: Prompter): Promise<boolean> {
  try {
    const where = await p.select({
      message: "Where should pochi run on schedule?",
      options: [
        { value: "local" as const, label: "This machine", hint: "launchd or cron; SLACK_WEBHOOK_URL from .env" },
        { value: "github" as const, label: "GitHub Actions", hint: "needs repository secrets" },
      ],
      initialValue: "local",
    });
    return where === "github";
  } catch (err) {
    // The config is already written, so a cancel here only skips the install; the next steps
    // still show how to run it on Actions.
    if (err instanceof PromptCancelled) return true;
    throw err;
  }
}

/**
 * Offers to install the job on this machine (launchd or cron) now that the config is written,
 * and whether it was installed.
 */
export async function offerInstall(
  p: Prompter,
  dir: string,
  context: Context,
  timeZone: string,
  deps: ScheduleDeps | undefined,
): Promise<boolean> {
  let wanted: boolean;
  try {
    wanted = await p.confirm({
      message: `Install the schedule on this machine now (${describeSchedule(context.schedule, context.schedule.timezone ?? timeZone)})?`,
      initialValue: true,
    });
  } catch (err) {
    // The config is already written, so a cancel here only skips the install.
    if (err instanceof PromptCancelled) return false;
    throw err;
  }
  if (!wanted) return false;
  return install(p, dir, deps);
}

/**
 * Installs the job on this machine, and whether it was. A failure is a warning: the config is
 * fine, and the next steps still show the command.
 */
export async function install(p: Prompter, dir: string, deps: ScheduleDeps | undefined): Promise<boolean> {
  const lines: string[] = [];
  try {
    await installSchedule({ configDir: dir }, { ...deps, write: (line) => void lines.push(line) });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    p.warn(`Could not install the schedule: ${err.message}`);
    return false;
  }
  p.note(lines.join("\n"), "Schedule");
  return true;
}
