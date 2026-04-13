class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message || "Request failed");
    this.name = "HttpError";
    this.status = Number(status) || 500;
    this.code = String(options.code || "HTTP_ERROR");
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

function createHttpError(status, message, options = {}) {
  return new HttpError(status, message, options);
}

function validationError(message, details) {
  return createHttpError(400, message || "Invalid request", {
    code: "VALIDATION_ERROR",
    details,
  });
}

function notFoundError(message, details) {
  return createHttpError(404, message || "Not found", {
    code: "NOT_FOUND",
    details,
  });
}

function conflictError(message, details) {
  return createHttpError(409, message || "Conflict", {
    code: "CONFLICT",
    details,
  });
}

function isHttpError(error) {
  return error instanceof HttpError || Boolean(error?.status);
}

module.exports = {
  HttpError,
  createHttpError,
  validationError,
  notFoundError,
  conflictError,
  isHttpError,
};
