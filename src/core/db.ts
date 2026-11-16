import pg from 'pg';

// numeric -> number (hours)
pg.types.setTypeParser(1700, (v) => Number(v));
// bigint -> number (ids fit in 2^53)
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Client = pg.PoolClient;

/** schema: optional search_path (used by tests to work in an isolated schema) */
export const createPool = (url: string, schema?: string): Db => {
  return new pg.Pool({
    connectionString: url,
    max: 5,
    options: schema ? `-c search_path=${schema}` : undefined,
  });
};

export const tx = async <T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> => {
  const c = await db.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
};
