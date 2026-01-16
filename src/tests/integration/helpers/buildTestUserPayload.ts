import { faker } from '@faker-js/faker';
import dayjs from '../../../lib/dayjs';

export const buildTestUserPayload = (seed: number = Date.now()) => {
    faker.seed(seed);
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    const timezone = faker.location.timeZone();
    const pastYear = faker.number.int({ min: 1970, max: dayjs().year() - 1 });
    const eventDate = dayjs().year(pastYear).format('YYYY-MM-DD');
    const notifyLocalTime = dayjs().format('HH:mm');
    const createEvent = {
      body: JSON.stringify({
        firstName,
        lastName,
        timezone,
        events: [
          { type: 'birthday', date: eventDate, notifyLocalTime },
        ],
      }),
    };
  
    return {
      firstName,
      lastName,
      timezone,
      eventDate,
      notifyLocalTime,
      createEvent,
    };
  };