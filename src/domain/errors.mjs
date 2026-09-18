/** 领域错误：携带稳定 code 与 HTTP 状态，便于接口层统一映射。 */
export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message, details) {
    super('VALIDATION_ERROR', message, { status: 400, details });
  }
}

export class NotFoundError extends DomainError {
  constructor(message) {
    super('NOT_FOUND', message, { status: 404 });
  }
}

export class ConflictError extends DomainError {
  constructor(message, details) {
    super('CONFLICT', message, { status: 409, details });
  }
}

export class AuthorizationError extends DomainError {
  constructor(message = '权限不足') {
    super('FORBIDDEN', message, { status: 403 });
  }
}

/** 事件流追加时序列号冲突：并发写入必须重试或失败。 */
export class ConcurrentModificationError extends DomainError {
  constructor(message = '事件流已被其他操作修改') {
    super('CONCURRENT_MODIFICATION', message, { status: 409 });
  }
}
