/**
 * Uygulama hataları. Beklenen (operasyonel) hataları beklenmeyen çökmelerden
 * ayırmak, hata yönetiminin temelidir: ilki kullanıcıya anlatılır, ikincisi
 * loglanır ve kullanıcıya asla sızdırılmaz.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    // 5xx hatalarının mesajı istemciye gösterilmez
    this.expose = statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Kimlik doğrulaması gerekli') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Bu işlem için yetkiniz yok') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Kayıt bulunamadı') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

export const tooManyRequests = (message = 'Çok fazla istek') =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);

export const internal = (message = 'Beklenmeyen bir hata oluştu') =>
  new AppError(500, 'INTERNAL_ERROR', message);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
