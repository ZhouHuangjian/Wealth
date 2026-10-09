import test from "node:test";
import assert from "node:assert/strict";
import {
  hexagrams,
  isMoving,
  isYang,
  leisureScenes,
  oracleResult,
  tossCoins,
} from "../src/leisure/coin-oracle.ts";

function controlledToss(bits) {
  let index = 0;
  return tossCoins(() => bits[index++]);
}

test("all eight three-coin outcomes follow the stated 3/2 convention", () => {
  const distribution = [0, 0, 0, 0];
  for (let pattern = 0; pattern < 8; pattern += 1) {
    const bits = [pattern & 1, (pattern >> 1) & 1, (pattern >> 2) & 1];
    const toss = controlledToss(bits);
    assert.deepEqual(
      toss.faces,
      bits.map((bit) => (bit ? "heads" : "tails")),
    );
    assert.equal(toss.value, 6 + bits.reduce((sum, bit) => sum + bit, 0));
    distribution[toss.value - 6] += 1;
  }
  assert.deepEqual(distribution, [1, 3, 3, 1]);
  assert.throws(() => controlledToss([1, 0, 2]), /必须是 0 或 1/);
});

test("yin, yang and moving lines are independent", () => {
  assert.deepEqual([6, 7, 8, 9].map(isYang), [false, true, false, true]);
  assert.deepEqual([6, 7, 8, 9].map(isMoving), [true, false, false, true]);
});

test("64 names map to every unique six-line pattern in canonical order", () => {
  assert.equal(hexagrams.length, 64);
  assert.equal(new Set(hexagrams.map((hexagram) => hexagram.bits)).size, 64);
  assert.equal(new Set(hexagrams.map((hexagram) => hexagram.name)).size, 64);
  assert.deepEqual(
    hexagrams.map((hexagram) => hexagram.number),
    Array.from({ length: 64 }, (_, index) => index + 1),
  );
  for (let pattern = 0; pattern < 64; pattern += 1) {
    const lines = Array.from({ length: 6 }, (_, index) =>
      (pattern >> index) & 1 ? 7 : 8,
    );
    const result = oracleResult(lines);
    assert.equal(
      result.original.bits,
      lines.map((line) => (line === 7 ? "1" : "0")).join(""),
    );
    assert.equal(result.changed, null);
    assert.deepEqual(result.moving, []);
    assert.equal(
      result.original.symbol.codePointAt(0),
      0x4dc0 + result.original.number - 1,
    );
  }
});

test("lower trigram starts at the first toss, including common reproduction errors", () => {
  const examples = [
    ["100010", "屯", "震", "坎", 3],
    ["010001", "蒙", "坎", "艮", 4],
    ["111000", "泰", "乾", "坤", 11],
    ["000111", "否", "坤", "乾", 12],
    ["000100", "豫", "坤", "震", 16],
    ["011100", "恒", "巽", "震", 32],
    ["111100", "大壮", "乾", "震", 34],
    ["101000", "明夷", "离", "坤", 36],
    ["110101", "睽", "兑", "离", 38],
    ["101010", "既济", "离", "坎", 63],
    ["010101", "未济", "坎", "离", 64],
  ];
  for (const [bits, name, lower, upper, number] of examples) {
    const actual = oracleResult(
      [...bits].map((bit) => (bit === "1" ? 7 : 8)),
    ).original;
    assert.deepEqual(
      [actual.name, actual.lower, actual.upper, actual.number],
      [name, lower, upper, number],
    );
  }
});

test("six stable yang and yin lines have no invented changed hexagram", () => {
  assert.equal(oracleResult([7, 7, 7, 7, 7, 7]).original.name, "乾");
  assert.equal(oracleResult([8, 8, 8, 8, 8, 8]).original.name, "坤");
  assert.equal(oracleResult([8, 8, 8, 8, 8, 8]).changed, null);
});

test("only moving lines flip, preserving the bottom-to-top positions", () => {
  const firstMoving = oracleResult([9, 7, 7, 7, 7, 7]);
  assert.equal(firstMoving.original.name, "乾");
  assert.deepEqual(firstMoving.moving, [1]);
  assert.equal(firstMoving.changed.name, "姤");
  assert.equal(firstMoving.changed.bits, "011111");
  const allYinMoving = oracleResult([6, 6, 6, 6, 6, 6]);
  assert.equal(allYinMoving.original.name, "坤");
  assert.equal(allYinMoving.changed.name, "乾");
  assert.deepEqual(allYinMoving.moving, [1, 2, 3, 4, 5, 6]);
  const mixed = oracleResult([6, 7, 8, 9, 7, 8]);
  assert.equal(mixed.original.bits, "010110");
  assert.equal(mixed.changed.bits, "110010");
  assert.deepEqual(mixed.moving, [1, 4]);
});

test("partial, excess or invalid lines cannot produce a result", () => {
  for (const lines of [
    [],
    [7],
    [7, 7, 7, 7, 7],
    [7, 7, 7, 7, 7, 7, 7],
    [7, 7, 7, 7, 7, 10],
  ]) {
    assert.throws(() => oracleResult(lines), /六个有效爻/);
  }
  assert.deepEqual(
    leisureScenes.map((scene) => scene.id),
    ["three-coins"],
  );
});
