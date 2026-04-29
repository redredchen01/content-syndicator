export const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string, err?: any) => {
    console.error(`[ERROR] ${msg}`);
    if (err) console.error(err);
  },
  success: (msg: string) => console.log(`[SUCCESS] ${msg}`)
};

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const randomSleep = (min: number, max: number) => sleep(Math.floor(Math.random() * (max - min + 1) + min));
