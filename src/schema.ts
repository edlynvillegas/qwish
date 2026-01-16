import * as z from 'zod';
import { USER_EVENT_NAME_VALUES } from './constants/userEventNames';

const isValidTimezone = (tz: string) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
};

export const userEventSchema = z.object({
    type: z.enum(USER_EVENT_NAME_VALUES, { 
        error: 'Type is required' 
      }),
    date: z.string('Date is required').min(1, 'Date is required'),
    notifyLocalTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Notify local time must be in HH:mm format')
        .optional().default('09:00'),
    label: z.string('Label is required').optional()
});

export const userSchema = z.object({
    firstName: z.string('First name is required').min(1, 'First name is required'),
    lastName: z.string('Last name is required').min(1, 'Last name is required'),
    timezone: z.string('Timezone is required').min(1, 'Timezone is required').refine(isValidTimezone, 'Invalid IANA timezone'),
});

export const createUserPayload = userSchema.extend({
    events: z.array(userEventSchema).min(1, "At least one event is required"),
});

export type CreateUserPayload = z.infer<typeof createUserPayload>;

export const updateUserPayload = createUserPayload.partial();
export type UpdateUserPayload = z.infer<typeof updateUserPayload>;

export const updateUserEventPayload = z.object({
    date: z.string().min(1, 'Date is required').optional(),
    notifyLocalTime: z.string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Notify local time must be in HH:mm format')
      .optional(),
    label: z.string().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
);
export type UpdateUserEventPayload = z.infer<typeof updateUserEventPayload>;

export const addUserEventPayload = userEventSchema;
export type AddUserEventPayload = z.infer<typeof addUserEventPayload>;