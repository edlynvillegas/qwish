import dayjs from "../lib/dayjs";

/**
 * Computes the next UTC timestamp when a birthday notification should be sent
 * at the specified local time in the user's timezone.
 * 
 * @param birthday - Birthday in YYYY-MM-DD format
 * @param tz - IANA timezone (e.g., 'America/New_York')
 * @param notifyLocalTime - Local time in HH:mm format (e.g., '09:00')
 * @param referenceTimeIso - Optional ISO timestamp to use as "now" (e.g., createdAt)
 * @returns ISO 8601 UTC timestamp
 */
export function computeNotifyUtc(
  birthday: string,
  tz: string,
  notifyLocalTime: string,
  referenceTimeIso?: string
): string {
    const referenceTime = referenceTimeIso ? dayjs(referenceTimeIso) : dayjs();
    const now = referenceTime.isValid() ? referenceTime : dayjs();
    let year = now.year();

    // Birthday this year
    let birthdayThisYear = dayjs(birthday).year(year).format('YYYY-MM-DD');
    let notifyUtc = dayjs.tz(`${birthdayThisYear}T${notifyLocalTime}`, tz)
                        .utc()
                        .toISOString();

    // If notifyUtc already passed, use next year
    if (dayjs(notifyUtc).isBefore(now)) {
        year += 1;
        birthdayThisYear = dayjs(birthday).year(year).format('YYYY-MM-DD');
        notifyUtc = dayjs.tz(`${birthdayThisYear}T${notifyLocalTime}`, tz)
                         .utc()
                         .toISOString();
    }

    return notifyUtc;
}
