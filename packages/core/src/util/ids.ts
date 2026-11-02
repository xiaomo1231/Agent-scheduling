export type IdPrefix = 'prj' | 'thr' | 'stp' | 'msg' | 'apv' | 'src' | 'grp' | 'agt' | 'rul' | 'wdg' | 'run' | 'skl' | 'mem' | 'chn' | 'rol';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 生成带前缀的 id。random 可注入，测试时得到稳定结果。 */
export function newId(prefix: IdPrefix, random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return `${prefix}_${s}`;
}

/** 一个可预测的随机数发生器，测试和回放用。 */
export function seededRandom(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}
