// The first bit/line is the bottom (初爻). Upper and lower trigrams follow
// the public-domain Zhou Yi text: https://zh.wikisource.org/wiki/周易.
// Cross-check against the 大象 text, not university reproductions' typo-prone headers.
// This scene chooses 正面=3, 反面=2 explicitly; no financial data is involved.
export type CoinFace = "heads" | "tails";
export type LineValue = 6 | 7 | 8 | 9;
export type CoinToss = {
  faces: [CoinFace, CoinFace, CoinFace];
  value: LineValue;
};

const trigrams = {
  0: { name: "坤", image: "地", bits: "000" },
  1: { name: "震", image: "雷", bits: "100" },
  2: { name: "坎", image: "水", bits: "010" },
  3: { name: "兑", image: "泽", bits: "110" },
  4: { name: "艮", image: "山", bits: "001" },
  5: { name: "离", image: "火", bits: "101" },
  6: { name: "巽", image: "风", bits: "011" },
  7: { name: "乾", image: "天", bits: "111" },
} as const;
type TrigramKey = keyof typeof trigrams;

// Canonical order. Each tuple is name, lower trigram, upper trigram.
const definitions: readonly [string, TrigramKey, TrigramKey][] = [
  ["乾", 7, 7],
  ["坤", 0, 0],
  ["屯", 1, 2],
  ["蒙", 2, 4],
  ["需", 7, 2],
  ["讼", 2, 7],
  ["师", 2, 0],
  ["比", 0, 2],
  ["小畜", 7, 6],
  ["履", 3, 7],
  ["泰", 7, 0],
  ["否", 0, 7],
  ["同人", 5, 7],
  ["大有", 7, 5],
  ["谦", 4, 0],
  ["豫", 0, 1],
  ["随", 1, 3],
  ["蛊", 6, 4],
  ["临", 3, 0],
  ["观", 0, 6],
  ["噬嗑", 1, 5],
  ["贲", 5, 4],
  ["剥", 0, 4],
  ["复", 1, 0],
  ["无妄", 1, 7],
  ["大畜", 7, 4],
  ["颐", 1, 4],
  ["大过", 6, 3],
  ["坎", 2, 2],
  ["离", 5, 5],
  ["咸", 4, 3],
  ["恒", 6, 1],
  ["遁", 4, 7],
  ["大壮", 7, 1],
  ["晋", 0, 5],
  ["明夷", 5, 0],
  ["家人", 5, 6],
  ["睽", 3, 5],
  ["蹇", 4, 2],
  ["解", 2, 1],
  ["损", 3, 4],
  ["益", 1, 6],
  ["夬", 7, 3],
  ["姤", 6, 7],
  ["萃", 0, 3],
  ["升", 6, 0],
  ["困", 2, 3],
  ["井", 6, 2],
  ["革", 5, 3],
  ["鼎", 6, 5],
  ["震", 1, 1],
  ["艮", 4, 4],
  ["渐", 4, 6],
  ["归妹", 3, 1],
  ["丰", 5, 1],
  ["旅", 4, 5],
  ["巽", 6, 6],
  ["兑", 3, 3],
  ["涣", 2, 6],
  ["节", 3, 2],
  ["中孚", 3, 6],
  ["小过", 4, 1],
  ["既济", 5, 2],
  ["未济", 2, 5],
];

export const hexagrams = definitions.map(([name, lower, upper], index) => ({
  number: index + 1,
  name,
  symbol: String.fromCodePoint(0x4dc0 + index),
  bits: trigrams[lower].bits + trigrams[upper].bits,
  lower: trigrams[lower].name,
  upper: trigrams[upper].name,
  image: `${trigrams[upper].image}在上，${trigrams[lower].image}在下`,
}));

export const lineNames: Record<LineValue, string> = {
  6: "老阴 · 动爻",
  7: "少阳",
  8: "少阴",
  9: "老阳 · 动爻",
};

export const linePositions = ["初爻", "二爻", "三爻", "四爻", "五爻", "上爻"];

export function tossCoins(drawBit: () => 0 | 1): CoinToss {
  const bits = [drawBit(), drawBit(), drawBit()];
  if (bits.some((bit) => bit !== 0 && bit !== 1)) {
    throw new Error("铜钱随机值必须是 0 或 1");
  }
  return {
    faces: bits.map((bit) => (bit ? "heads" : "tails")) as CoinToss["faces"],
    value: (6 + bits.reduce<number>((sum, bit) => sum + bit, 0)) as LineValue,
  };
}

function validateLines(lines: readonly LineValue[]) {
  if (
    lines.length !== 6 ||
    lines.some((line) => ![6, 7, 8, 9].includes(line))
  ) {
    throw new Error("完整卦象需要六个有效爻，按初爻至上爻排列");
  }
}

export function isMoving(line: LineValue) {
  return line === 6 || line === 9;
}

export function isYang(line: LineValue) {
  return line === 7 || line === 9;
}

export function oracleResult(lines: readonly LineValue[]) {
  validateLines(lines);
  const bits = lines.map((line) => (isYang(line) ? "1" : "0")).join("");
  const changedBits = lines
    .map((line) => (isYang(line) !== isMoving(line) ? "1" : "0"))
    .join("");
  const moving = lines.flatMap((line, index) =>
    isMoving(line) ? [index + 1] : [],
  );
  return {
    original: hexagrams.find((hexagram) => hexagram.bits === bits)!,
    changed: moving.length
      ? hexagrams.find((hexagram) => hexagram.bits === changedBits)!
      : null,
    moving,
  };
}

// Add implemented scenes here. The selector never advertises placeholder games.
export const leisureScenes = [
  {
    id: "three-coins",
    name: "三枚铜钱",
    description: "掷六次，看看六爻组成的卦象",
  },
] as const;
