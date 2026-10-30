// Client-only document composition. Validation/publication authority stays in PostgreSQL.
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Document = { [key: string]: Value };
export type Collection = 'tours' | 'departures' | 'content';
export type ContentKind = 'organizer' | 'report' | 'review' | 'legal';
export interface Item { id: string; slug: string; kind?: ContentKind; title?: string | null; publishedVersion: number | null; draftRevision: number | null; tourId?: string }
export interface Revision { version: number; draftRevision: number; document: Document; documentSha256: string; publishedBy: string; publishedAt: string; effectiveOn?: string; textSha256?: string; approval?: string }
export interface Entity { row: Record<string, Value>; draft: { revision: number; document: Document } | null; revisions: Revision[]; publishedDocument: Document | null }
export const object = (v: Value | undefined): Document => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
export const TOUR_CONTRACT: Document = { destination: '', route: '', program: [{ title: '', items: [''] }], included: [''], excluded: [], insurance: null, risks: '' };
export const DEPARTURE_FACTS: Document = { departurePoint: '', returnPoint: '', accommodation: { name: '', address: '', category: null, registryNumber: null, roomType: '', nights: 0, meals: '', legalEntity: '' }, carrier: { legalName: '', route: '', vehicle: null, baggage: '', boarding: '' }, services: [] };
export const LABELS: Record<string, string> = {
  slug: 'Адрес (slug)', title: 'Название', name: 'Имя / название', authorName: 'Автор отзыва', isListed: 'Показывать на сайте', isDemo: 'Демонстрационные данные', noindex: 'Запретить индексацию',
  startsOn: 'Дата отправления', endsOn: 'Дата возвращения', departureTime: 'Время отправления', returnTime: 'Время возвращения', timezone: 'Часовой пояс', priceKopecks: 'Цена для новых заявок, коп.',
  destination: 'Направление', route: 'Маршрут', program: 'Программа', items: 'Пункты программы', included: 'Включено', excluded: 'Не включено', insurance: 'Страхование', risks: 'Риски',
  departurePoint: 'Место отправления', returnPoint: 'Место возвращения', accommodation: 'Размещение', address: 'Адрес', category: 'Категория', registryNumber: 'Номер в реестре', roomType: 'Номер', nights: 'Ночей', meals: 'Питание', legalEntity: 'Поставщик размещения', carrier: 'Перевозчик', legalName: 'Юридическое наименование', vehicle: 'Транспорт', baggage: 'Багаж', boarding: 'Посадка', services: 'Услуги', supplier: 'Поставщик', note: 'Примечание',
  summary: 'Краткое описание', description: 'Описание', body: 'Текст', seoTitle: 'SEO: заголовок', seoDescription: 'SEO: описание', tour: 'Тур (slug)', departure: 'Выезд (slug)', date: 'Дата', organizers: 'Организаторы (slug)',
  heading: 'Заголовок страницы', shortDescription: 'Краткое описание', sortOrder: 'Порядок сортировки', updatedAt: 'Дата значимого изменения', phone: 'Телефон', bio: 'Об организаторе', seo: 'SEO',
};
export function initialDocument(collection: Collection, item: Item): Document {
  if (collection === 'tours') return { slug: item.slug, title: '', isListed: false, contract: null, content: {} };
  if (collection === 'departures') return { slug: item.slug, startsOn: '', endsOn: '', departureTime: '', returnTime: '', timezone: 'Asia/Krasnoyarsk', priceKopecks: null, contract: null, organizers: [], content: {} };
  switch (item.kind) {
    case 'organizer': return { slug: item.slug, name: '', isListed: false, isDemo: false, content: {} };
    case 'report': return { slug: item.slug, title: '', tour: '', departure: null, date: null, isListed: false, noindex: false, content: {} };
    case 'review': return { slug: item.slug, authorName: '', tour: null, isListed: false, isDemo: false, content: {} };
    default: return { slug: item.slug, title: '', content: { body: '' } };
  }
}
export function arrayEntry(key: string): Value {
  if (key === 'program') return { title: '', items: [''] };
  if (key === 'services') return { name: '', supplier: '', included: false, note: null };
  return '';
}
