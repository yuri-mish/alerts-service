// Публічні статичні сторінки без ключа: лендінг, robots.txt, sitemap.xml, іконка.
// Усе читається/збирається один раз при старті.
import { readFileSync, statSync } from 'node:fs';

export type StaticPage = {
  contentType: string;
  body: Buffer | string;
  cacheControl: string;
  /** Додаткові заголовки відповіді (напр. X-Robots-Tag) */
  headers?: Record<string, string>;
};

const ONE_HOUR = 'public, max-age=3600';
const FIVE_MINUTES = 'public, max-age=300';

/** Шляхи API, які пошуковикам індексувати нема чого (без ключа там 401) */
const API_PATHS = ['/periods', '/summary', '/1c/', '/alerts/', '/runs', '/regions', '/keys', '/sync',
  '/key-requests', '/contact', '/telegram/', '/health'];
// /stats свідомо НЕ закритий: лендінг тягне його для графіка, інакше Google рендерить сторінку без графіка.
// /admin свідомо НЕ в robots.txt: заборона там не дає роботу побачити noindex і публічно підказує адресу адмінки.
// Адмінку закриває заголовок X-Robots-Tag (+ мета-тег noindex на самій сторінці).

/** Файл підтвердження власності для Google Search Console (вміст задає Google) */
const GOOGLE_VERIFICATION_FILE = 'google5308e0fa9e956d6c.html';

const fileUrl = (name: string) => new URL(`./${name}`, import.meta.url);

const buildRobots = (publicUrl: string): string => {
  const lines = [
    'User-agent: *',
    ...API_PATHS.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${publicUrl}/sitemap.xml`,
    '',
  ];
  return lines.join('\n');
};

/** lastmod - дата зміни файла лендінгу */
const buildSitemap = (publicUrl: string, landingModified: Date): string => {
  const lastmod = landingModified.toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${publicUrl}/</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq></url>`,
    '</urlset>',
    '',
  ].join('\n');
};

export const createSitePages = (publicUrl: string): Map<string, StaticPage> => {
  const landing = fileUrl('landing.html');
  return new Map<string, StaticPage>([
    ['/', { contentType: 'text/html; charset=utf-8', body: readFileSync(landing), cacheControl: FIVE_MINUTES }],
    ['/robots.txt', { contentType: 'text/plain; charset=utf-8', body: buildRobots(publicUrl), cacheControl: ONE_HOUR }],
    ['/sitemap.xml', {
      contentType: 'application/xml; charset=utf-8',
      body: buildSitemap(publicUrl, statSync(landing).mtime),
      cacheControl: ONE_HOUR,
    }],
    // адмінка: сама сторінка без ключа, усі дані - через API з ключем адміністратора
    ['/admin', {
      contentType: 'text/html; charset=utf-8',
      body: readFileSync(fileUrl('admin.html')),
      cacheControl: 'no-store',
      headers: { 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
    }],
    ['/favicon.svg', { contentType: 'image/svg+xml', body: readFileSync(fileUrl('favicon.svg')), cacheControl: ONE_HOUR }],
    [`/${GOOGLE_VERIFICATION_FILE}`, {
      contentType: 'text/html; charset=utf-8',
      body: `google-site-verification: ${GOOGLE_VERIFICATION_FILE}`,
      cacheControl: ONE_HOUR,
    }],
  ]);
};
