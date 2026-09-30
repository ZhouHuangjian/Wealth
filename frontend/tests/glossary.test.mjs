import test from "node:test";
import assert from "node:assert/strict";
import {
  glossaryParts,
  findGlossaryEntry,
  searchGlossary,
  glossary,
  mergeGlossary,
  glossaryConflict,
  setGlossaryVisibility,
} from "../src/glossary-model.ts";

test("hiding and showing a configured term preserves its explanation, aliases and example", () => {
  const entry = {
    term: "净资产",
    category: "合成分类",
    explanation: "验收编辑说明",
    aliases: ["验收别名"],
    example: "验收示例",
  };
  const source = [entry];
  const hidden = setGlossaryVisibility(source, entry.term, true);
  assert.equal(findGlossaryEntry("净资产", mergeGlossary(hidden)), undefined);
  assert.equal(
    mergeGlossary(hidden, true).find((row) => row.term === entry.term)
      .explanation,
    entry.explanation,
  );
  const shown = setGlossaryVisibility(hidden, entry.term, false);
  assert.deepEqual(shown, [{ ...entry, hidden: false }]);
  assert.equal(
    findGlossaryEntry("验收别名", mergeGlossary(shown)).example,
    entry.example,
  );
  assert.deepEqual(source, [entry]);
  assert.equal(entry.hidden, undefined);
  assert.notEqual(
    findGlossaryEntry("净资产", mergeGlossary([])).explanation,
    entry.explanation,
  );
});

test("showing an unedited built-in removes only its visibility tombstone", () => {
  const source = [
    { term: "验收附加词", category: "合成", explanation: "保留其他配置" },
  ];
  const hidden = setGlossaryVisibility(source, "净资产", true);
  assert.deepEqual(hidden.at(-1), { term: "净资产", hidden: true });
  assert.deepEqual(setGlossaryVisibility(hidden, "净资产", false), source);
});

test("help selects precise compound terms without losing original label text", () => {
  const label = "昨结净资产 / 今日估算 · 机构权益快照";
  const parts = glossaryParts(label);
  assert.equal(parts.map((part) => part.text).join(""), label);
  assert.deepEqual(
    parts.filter((part) => part.entry).map((part) => part.entry.term),
    ["昨结净资产", "今日估算", "机构权益快照"],
  );
});

test("term lookup supports aliases and avoids partial Latin matches", () => {
  assert.equal(findGlossaryEntry("qdii").term, "QDII");
  assert.equal(findGlossaryEntry("红利再投").term, "红利再投资");
  assert.equal(
    glossaryParts("MYETF123").filter((part) => part.entry).length,
    0,
  );
  assert.equal(
    glossaryParts("QDII 的 T+2 确认日").filter((part) => part.entry).length,
    3,
  );
});

test("beginner search finds explanations and filters categories", () => {
  assert.equal(searchGlossary("5000")[0].term, "期初余额");
  assert.ok(searchGlossary("保证金", "投资与收益").length > 0);
  assert.equal(searchGlossary("保证金", "规划与管理").length, 0);
  assert.ok(
    searchGlossary("分红").some((entry) => entry.term === "红利再投资"),
  );
  assert.equal(searchGlossary("不存在的测试词").length, 0);
});

test("vocabulary aliases are unambiguous and critical concepts have explanations", () => {
  const labels = glossary.flatMap((entry) => [
    entry.term,
    ...(entry.aliases || []),
  ]);
  assert.equal(
    labels.length,
    new Set(labels.map((label) => label.toLowerCase())).size,
  );
  for (const term of [
    "期初余额",
    "机构权益快照",
    "净资产",
    "现金分红",
    "红利再投资",
    "权益登记日",
    "期权",
    "邀请码",
    "配置模板",
  ]) {
    assert.ok(findGlossaryEntry(term)?.explanation.length > 25, term);
  }
});

test("configured help replaces built-in explanations and aliases without mutating defaults", () => {
  const original = findGlossaryEntry("净资产").explanation;
  const entries = mergeGlossary([
    {
      term: "净资产",
      category: "自定义分类",
      explanation: "家庭目前的资产扣除债务。",
      aliases: ["家庭净值"],
      example: "资产 10 元，债务 2 元，净资产 8 元。",
    },
  ]);
  assert.equal(findGlossaryEntry("家庭净值", entries).term, "净资产");
  assert.equal(findGlossaryEntry("净资产", entries).category, "自定义分类");
  assert.equal(searchGlossary("债务", "自定义分类", entries).length, 1);
  assert.equal(findGlossaryEntry("净资产").explanation, original);
});

test("hidden built-in vocabulary removes its aliases from hover help and search", () => {
  const entries = mergeGlossary([{ term: "红利再投资", hidden: true }]);
  assert.equal(findGlossaryEntry("红利再投资", entries), undefined);
  assert.equal(findGlossaryEntry("红利再投", entries), undefined);
  assert.equal(
    glossaryParts("红利再投资", entries).some(
      (part) => part.entry?.term === "红利再投资",
    ),
    false,
  );
  assert.ok(
    mergeGlossary([{ term: "红利再投资", hidden: true }], true).find(
      (entry) => entry.term === "红利再投资",
    ).hidden,
  );
  assert.ok(findGlossaryEntry("红利再投", mergeGlossary([])));
});

test("customized labels stay plain text and collisions include unchanged built-in aliases", () => {
  const custom = {
    term: "示例名词",
    category: "自定义",
    explanation: "<script>alert(1)</script>",
    aliases: ["试用名词"],
  };
  const entries = mergeGlossary([custom]);
  assert.equal(
    findGlossaryEntry("试用名词", entries).explanation,
    custom.explanation,
  );
  assert.equal(
    glossaryParts("这是试用名词", entries)
      .map((part) => part.text)
      .join(""),
    "这是试用名词",
  );
  assert.equal(glossaryConflict(entries), "");
  assert.match(
    glossaryConflict(mergeGlossary([{ ...custom, aliases: ["市值"] }])),
    /市值/,
  );
  assert.match(
    glossaryConflict(mergeGlossary([{ ...custom, aliases: ["示例名词"] }])),
    /示例名词/,
  );
  assert.equal(
    glossaryConflict(
      mergeGlossary([
        { term: "持仓价值", hidden: true },
        { ...custom, aliases: ["市值"] },
      ]),
    ),
    "",
  );
});
