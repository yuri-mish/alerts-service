type Fields = Record<string, unknown>;

const write = (level: string, msg: string, fields?: Fields): void => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export const log = {
  info: (msg: string, f?: Fields) => write('info', msg, f),
  warn: (msg: string, f?: Fields) => write('warn', msg, f),
  error: (msg: string, f?: Fields) => write('error', msg, f),
};
