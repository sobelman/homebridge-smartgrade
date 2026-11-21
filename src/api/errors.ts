/** Base error for the SmartGrade cloud API. */
export class SmartGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The cloud could not be reached or returned an unexpected response. */
export class SmartGradeConnectionError extends SmartGradeError {}

/** The cloud rejected a request with an HTTP error status (not 401/403). */
export class SmartGradeRequestError extends SmartGradeError {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The user JWT is missing, expired or rejected.
 *
 * The service has no refresh endpoint, so the only fix is a new SMS login
 * (from the plugin's settings screen in the Homebridge UI).
 */
export class SmartGradeAuthError extends SmartGradeError {}
