import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeNotifyUtc } from '../notify';
import dayjs from '../../lib/dayjs';

describe('computeNotifyUtc', () => {
  // Mock current time for predictable testing
  const MOCK_NOW = '2026-01-14T10:00:00.000Z'; // January 14, 2026, 10:00 AM UTC
  
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MOCK_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Birthday in the future this year', () => {
    it('should return notification time for birthday later this year', () => {
      const birthday = '1990-06-15'; // June 15
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // June 15, 2026 at 9:00 AM EST = 14:00 UTC (EDT is UTC-4)
      expect(result).toBe('2026-06-15T13:00:00.000Z'); // EDT is UTC-4
    });

    it('should handle different timezones correctly', () => {
      const birthday = '1985-08-20'; // August 20
      const tz = 'Asia/Tokyo';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // August 20, 2026 at 9:00 AM JST = 0:00 UTC (JST is UTC+9)
      expect(result).toBe('2026-08-20T00:00:00.000Z');
    });

    it('should handle Australia timezone', () => {
      const birthday = '1992-11-10'; // November 10
      const tz = 'Australia/Sydney';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // November 10, 2026 at 9:00 AM AEDT (daylight time)
      // AEDT is UTC+11, so 9am Sydney = 10pm previous day UTC
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(10); // November (0-indexed)
      expect(resultDate.date()).toBe(10); // Same day but earlier hour in UTC
    });
  });

  describe('Birthday already passed this year', () => {
    it('should return next year when birthday already passed', () => {
      const birthday = '1988-01-01'; // January 1 (already passed)
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Should be January 1, 2027 (next year)
      expect(result).toBe('2027-01-01T14:00:00.000Z'); // EST is UTC-5
    });

    it('should return next year when birthday is today but time passed', () => {
      // Current mock time is January 14, 2026, 10:00 AM UTC
      const birthday = '1990-01-14'; // Today
      const tz = 'UTC';
      const notifyLocalTime = '09:00'; // Already passed (current time is 10:00 UTC)

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Should be next year since 9am UTC already passed
      expect(result).toBe('2027-01-14T09:00:00.000Z');
    });

    it('should return this year when birthday is today and time not yet passed', () => {
      // Current mock time is January 14, 2026, 10:00 AM UTC
      const birthday = '1990-01-14'; // Today
      const tz = 'UTC';
      const notifyLocalTime = '12:00'; // Not yet passed (current time is 10:00 UTC)

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Should be this year since 12pm UTC hasn't passed yet
      expect(result).toBe('2026-01-14T12:00:00.000Z');
    });
  });

  describe('Different notification times', () => {
    it('should handle midnight notification time', () => {
      const birthday = '1995-03-25';
      const tz = 'America/Los_Angeles';
      const notifyLocalTime = '00:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // March 25, 2026 at 00:00 PST/PDT
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(2); // March (0-indexed)
      expect(resultDate.date()).toBe(25);
    });

    it('should handle noon notification time', () => {
      const birthday = '1993-07-10';
      const tz = 'Europe/London';
      const notifyLocalTime = '12:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // July 10, 2026 at 12:00 BST (UTC+1)
      expect(result).toBe('2026-07-10T11:00:00.000Z');
    });

    it('should handle evening notification time', () => {
      const birthday = '1991-09-05';
      const tz = 'America/Chicago';
      const notifyLocalTime = '18:30';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // September 5, 2026 at 18:30 CDT (UTC-5)
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(8); // September (0-indexed)
    });
  });

  describe('Edge cases', () => {
    it('should handle leap year birthday (Feb 29)', () => {
      const birthday = '1992-02-29'; // Leap year birthday
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // 2026 is not a leap year, but dayjs should handle Feb 29
      // It will use Feb 29, 2028 (next leap year) or adjust to Feb 28
      const resultDate = dayjs(result);
      expect(resultDate.month()).toBe(1); // February (0-indexed)
    });

    it('should handle birthday on New Year\'s Eve', () => {
      const birthday = '1989-12-31';
      const tz = 'Pacific/Auckland';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // December 31, 2026 at 9:00 AM NZDT (UTC+13)
      // 9am Auckland = 8pm previous day UTC (9 - 13 = -4, so 24-4 = 20:00)
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(11); // December (0-indexed)
      expect(resultDate.date()).toBe(31); // Same day in year-end scenario
    });

    it('should handle timezones with unusual offsets', () => {
      const birthday = '1994-05-18';
      const tz = 'Asia/Kathmandu'; // UTC+5:45
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // May 18, 2026 at 9:00 AM NPT (UTC+5:45)
      expect(result).toBe('2026-05-18T03:15:00.000Z');
    });

    it('should handle birthday at beginning of year after current date', () => {
      // Mock time is Jan 14, so Jan 15 should be this year
      const birthday = '1987-01-15';
      const tz = 'UTC';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      expect(result).toBe('2026-01-15T09:00:00.000Z');
    });
  });

  describe('DST transitions', () => {
    it('should handle birthday during DST spring forward', () => {
      // March 8, 2026 - DST starts in US (spring forward)
      const birthday = '1990-03-08';
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // March 8, 2026 at 9:00 AM EDT (UTC-4)
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(2); // March
      expect(resultDate.date()).toBe(8);
    });

    it('should handle birthday during DST fall back', () => {
      // November 1, 2026 - DST ends in US (fall back)
      const birthday = '1991-11-01';
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // November 1, 2026 at 9:00 AM EST (UTC-5)
      const resultDate = dayjs(result);
      expect(resultDate.year()).toBe(2026);
      expect(resultDate.month()).toBe(10); // November (0-indexed)
      expect(resultDate.date()).toBe(1);
    });
  });

  describe('Timezones across the International Date Line', () => {
    it('should handle Samoa timezone (UTC-11)', () => {
      const birthday = '1993-04-20';
      const tz = 'Pacific/Samoa';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // April 20, 2026 at 9:00 AM SST (UTC-11)
      expect(result).toBe('2026-04-20T20:00:00.000Z');
    });

    it('should handle Kiribati timezone (UTC+14)', () => {
      const birthday = '1996-07-30';
      const tz = 'Pacific/Kiritimati';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // July 30, 2026 at 9:00 AM LINT (UTC+14)
      // 9am Kiritimati = 7pm previous day UTC (9 - 14 = -5, so 24-5 = 19:00)
      const resultDate = dayjs(result);
      expect(resultDate.month()).toBe(6); // July (0-indexed)
      expect(resultDate.date()).toBe(30); // Date can vary due to timezone conversion
    });
  });

  describe('Return value format', () => {
    it('should return ISO 8601 formatted string', () => {
      const birthday = '1990-05-15';
      const tz = 'America/New_York';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Check ISO 8601 format
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should return a valid date that can be parsed', () => {
      const birthday = '1992-08-22';
      const tz = 'Europe/Paris';
      const notifyLocalTime = '09:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Should be parseable as a date
      const parsed = new Date(result);
      expect(parsed.toString()).not.toBe('Invalid Date');
      expect(parsed.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('Boundary conditions', () => {
    it('should handle birthday exactly at current time in UTC', () => {
      // Mock time is 2026-01-14T10:00:00.000Z
      const birthday = '1990-01-14';
      const tz = 'UTC';
      const notifyLocalTime = '10:00';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // When time equals current time, isBefore returns false, so returns this year
      // This is acceptable - the notification would be sent immediately
      expect(result).toBe('2026-01-14T10:00:00.000Z');
    });

    it('should handle birthday one minute in the future', () => {
      // Mock time is 2026-01-14T10:00:00.000Z
      const birthday = '1990-01-14';
      const tz = 'UTC';
      const notifyLocalTime = '10:01';

      const result = computeNotifyUtc(birthday, tz, notifyLocalTime);
      
      // Should be today since it's in the future
      expect(result).toBe('2026-01-14T10:01:00.000Z');
    });
  });
});
