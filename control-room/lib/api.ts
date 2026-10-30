// The only way the Control Room talks to anything: same-origin JSON calls to /api/, with the
// HttpOnly session cookie the browser attaches by itself. The bundle holds no credential, token or
// key; it never reads the cookie and never stores anything in localStorage.

export type Role = "OWNER" | "EDITOR";

export interface SessionInfo {
  login: string;
  role: Role;
  sessionId: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

const MESSAGES: Record<string, string> = {
  MEDIA_BUSY: "Фото сейчас обрабатывается. Повторите действие через несколько секунд.",
  MEDIA_QUEUE_FULL: "Очередь обработки заполнена. Повторите загрузку позже.",
  MEDIA_STATE_CONFLICT: "Действие недоступно в текущем состоянии фото. Обновите статусы.",
  MEDIA_IDEMPOTENCY_CONFLICT: "Этот запрос уже использован для другого фото. Выберите файл заново.",
  MEDIA_INVALID: "Проверьте файл, описание, автора и основание публикации.",
  MEDIA_SIZE: "Допустимый размер изображения — до 8 МиБ.",
  INVALID_CREDENTIALS: "Неверный логин, пароль или код.",
  RATE_LIMITED: "Слишком много попыток. Подождите и попробуйте снова.",
  TOTP_ENROLLMENT_REQUIRED: "Для этого аккаунта ещё не подключён аутентификатор.",
  TOTP_ALREADY_ENROLLED: "Аутентификатор уже подключён. Сброс — только через оператора по SSH.",
  TOTP_ENROLLMENT_CLOSED: "Окно подключения аутентификатора истекло. Попросите оператора сбросить TOTP.",
  UNAUTHENTICATED: "Сессия истекла. Войдите снова.",
  FORBIDDEN: "Недостаточно прав: публикация доступна только владельцу.",
  ORIGIN_REFUSED: "Запрос отклонён: открыт не с адреса Control Room.",
  DRAFT_REVISION_CONFLICT: "Черновик изменён в другой вкладке. Обновите страницу.",
  PUBLISHED_VERSION_CONFLICT: "Опубликованная версия уже изменилась. Обновите страницу.",
  EXECUTION_CHANGE_CLASSIFICATION_REQUIRED: "По выезду есть заказы: изменение условий требует классификации.",
  ORDER_CHANGE_STAGE_B_REQUIRED: "По выезду есть заказы. Изменение расписания и условий пока закрыто; требуется этап работы с действующими заказами.",
  DEPARTURE_CONTROL_CONFLICT: "Состояние выезда изменилось. Обновите состояние и повторите действие.",
  GLOBAL_OPERATOR_STOP: "Продажи закрыты оператором. Control Room не может снять глобальную остановку.",
  CAPACITY_BELOW_TAKEN: "Вместимость должна быть не меньше количества занятых мест и больше нуля.",
  DEPARTURE_NOT_PUBLIC: "Для открытия выезд и его тур должны быть опубликованы и показаны на сайте.",
  DEPARTURE_INCOMPLETE: "Для открытия заполните цену, вместимость и все условия выезда.",
  DEPARTURE_STARTED: "Выезд уже начался. Открыть продажи нельзя.",
  DEPARTURE_CANCELLED: "Выезд отменён или запрошена отмена. Возобновление запрещено.",
  LEGAL_APPROVAL_INVALID: "Укажите дату действия, основание одобрения и непустой текст правового документа.",
  TOUR_DOCUMENT_INVALID: "Проверьте название, адрес и условия тура.",
  DEPARTURE_DOCUMENT_INVALID: "Проверьте даты, время, часовой пояс, цену и условия выезда.",
  CONTENT_DOCUMENT_INVALID: "Проверьте обязательные поля материала и связи с туром или выездом.",
  SLUG_TAKEN: "Этот адрес уже используется. Выберите другой.",
  NETWORK: "Admin API недоступен. Попробуйте позже.",
};

export const messageFor = (e: unknown) =>
  e instanceof ApiError ? (MESSAGES[e.code] ?? `Ошибка (${e.code}).`) : MESSAGES.NETWORK;

export async function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : "UNKNOWN");
  return data as T;
}
