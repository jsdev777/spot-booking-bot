export class SlotTakenError extends Error {
  constructor() {
    super('Slot no longer available');
    this.name = 'SlotTakenError';
  }
}

export class BookingNotFoundError extends Error {
  constructor() {
    super('Booking not found or not allowed');
    this.name = 'BookingNotFoundError';
  }
}

export class SlotInPastError extends Error {
  constructor() {
    super('Slot start is in the past');
    this.name = 'SlotInPastError';
  }
}

/** Currently outside the booking window set for the community. */
export class BookingWindowClosedError extends Error {
  constructor() {
    super('Community booking window is closed');
    this.name = 'BookingWindowClosedError';
  }
}

/** The user's daily booking limit in the community has been exceeded (as per group settings). */
export class UserDailyBookingLimitExceededError extends Error {
  constructor() {
    super('User daily booking limit exceeded for community');
    this.name = 'UserDailyBookingLimitExceededError';
  }
}
