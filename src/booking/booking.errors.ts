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

/** Сейчас вне окна бронирования, заданного для сообщества. */
export class BookingWindowClosedError extends Error {
  constructor() {
    super('Community booking window is closed');
    this.name = 'BookingWindowClosedError';
  }
}

/** Превышен дневной лимит бронирования пользователя в сообществе (по настройке группы). */
export class UserDailyBookingLimitExceededError extends Error {
  constructor() {
    super('User daily booking limit exceeded for community');
    this.name = 'UserDailyBookingLimitExceededError';
  }
}
