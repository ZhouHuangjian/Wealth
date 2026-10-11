import { useEffect, useRef, useState } from "react";
import { Button, Modal, Select, Space, Tag } from "antd";
import { Coins, RotateCcw } from "lucide-react";
import {
  isYang,
  leisureScenes,
  lineNames,
  linePositions,
  oracleResult,
  tossCoins,
} from "./coin-oracle";
import type { CoinFace, CoinToss, LineValue } from "./coin-oracle";
import "./leisure-corner.css";

function Coin({
  face,
  index,
  tossing,
}: {
  face: CoinFace;
  index: number;
  tossing: boolean;
}) {
  return (
    <span
      className={`leisure-coin ${tossing ? "is-tossing" : ""}`}
      style={{ animationDelay: `${index * 55}ms` }}
      role="img"
      aria-label={`第${index + 1}枚铜钱：${face === "heads" ? "正面" : "反面"}`}
    >
      <span
        className={`leisure-coin-inner ${face === "tails" ? "is-tails" : ""}`}
      >
        <span className="leisure-coin-face leisure-coin-front">
          <span>乾</span>
          <span>正</span>
          <span>坤</span>
          <i />
        </span>
        <span className="leisure-coin-face leisure-coin-back">
          <span>拾</span>
          <span>反</span>
          <span>趣</span>
          <i />
        </span>
      </span>
    </span>
  );
}

function Line({ value, position }: { value?: LineValue; position: number }) {
  return (
    <div className={`leisure-line ${value ? "" : "is-empty"}`}>
      <small>{linePositions[position]}</small>
      <span
        className={`leisure-line-mark ${value && isYang(value) ? "is-yang" : "is-yin"}`}
        aria-hidden="true"
      >
        <i />
        <i />
      </span>
      <span>{value ? lineNames[value] : "未掷"}</span>
    </div>
  );
}

function ThreeCoins() {
  const [tosses, setTosses] = useState<CoinToss[]>([]);
  const [faces, setFaces] = useState<CoinToss["faces"]>([
    "heads",
    "heads",
    "heads",
  ]);
  const [tossing, setTossing] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => {
      preference.removeEventListener("change", update);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const lines = tosses.map((toss) => toss.value);
  const result = tosses.length === 6 ? oracleResult(lines) : null;
  function toss() {
    if (busy.current || tosses.length >= 6) return;
    setError("");
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(3));
      let index = 0;
      const next = tossCoins(() => (bytes[index++] & 1) as 0 | 1);
      busy.current = true;
      setTossing(true);
      timer.current = setTimeout(
        () => {
          setFaces(next.faces);
          setTosses((previous) => [...previous, next]);
          setTossing(false);
          busy.current = false;
          timer.current = null;
        },
        reducedMotion ? 0 : 780,
      );
    } catch {
      setError("暂时无法掷币，请重新打开后再试。");
    }
  }
  function reset() {
    if (busy.current) return;
    setTosses([]);
    setFaces(["heads", "heads", "heads"]);
    setError("");
  }
  return (
    <div className="leisure-oracle">
      <p className="leisure-caption">掷三枚铜钱，从初爻往上，六次成一卦。</p>
      <button
        className="leisure-toss-target"
        onClick={toss}
        disabled={tossing || !!result}
        aria-label={
          result
            ? "六爻已成，请重新起卦"
            : `掷三枚铜钱，生成${linePositions[tosses.length]}`
        }
      >
        <span className="leisure-coins">
          {faces.map((face, index) => (
            <Coin key={index} face={face} index={index} tossing={tossing} />
          ))}
        </span>
        <span className="leisure-toss-label">
          {tossing
            ? "铜钱翻转中…"
            : result
              ? "六爻已成"
              : `点击掷币 · 第 ${tosses.length + 1} / 6 次`}
        </span>
      </button>
      <div
        className="leisure-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {error ||
          (result
            ? `本卦${result.original.name}，${result.moving.length ? `动爻${result.moving.join("、")}，变卦${result.changed!.name}` : "无动爻"}`
            : tosses.length
              ? `第 ${tosses.length} 次：${faces.map((face) => (face === "heads" ? "正" : "反")).join(" · ")}，${tosses.at(-1)!.value}，${lineNames[tosses.at(-1)!.value]}`
              : "点击铜钱开始，也可用回车或空格掷币。")}
      </div>
      <div className="leisure-hexagram-lines" aria-label="六爻，自下向上生成">
        {[5, 4, 3, 2, 1, 0].map((position) => (
          <Line key={position} value={lines[position]} position={position} />
        ))}
      </div>
      {result && (
        <div className="leisure-result">
          <div>
            <small>本卦 · 第 {result.original.number} 卦</small>
            <h3>
              <span aria-hidden="true">{result.original.symbol}</span>
              {result.original.name}
            </h3>
            <p>{result.original.image}</p>
            <span className="leisure-trigrams">
              上卦{result.original.upper} · 下卦{result.original.lower}
            </span>
          </div>
          {result.changed && (
            <div>
              <small>变卦 · 第 {result.changed.number} 卦</small>
              <h3>
                <span aria-hidden="true">{result.changed.symbol}</span>
                {result.changed.name}
              </h3>
              <p>{result.changed.image}</p>
              <span className="leisure-trigrams">
                {result.moving
                  .map((position) => linePositions[position - 1])
                  .join("、")}
                变
              </span>
            </div>
          )}
          {!result.changed && (
            <p className="leisure-no-change">本次没有动爻，卦象不变。</p>
          )}
        </div>
      )}
      <Space className="leisure-actions">
        <Button
          icon={<RotateCcw size={15} />}
          onClick={reset}
          disabled={tossing || !tosses.length}
        >
          重新起卦
        </Button>
        <Tag bordered={false}>仅供娱乐</Tag>
      </Space>
      <details className="leisure-instructions">
        <summary>怎么玩</summary>
        <p>
          本场景约定正面 3、反面 2，相加为 6、7、8 或 9。7、9 为阳爻，6、8
          为阴爻；6、9 是动爻，翻转阴阳后组成变卦。
        </p>
        <p>图象用来认识传统卦名，不用于预测。结果仅留在本次窗口中。</p>
        <a
          href="https://zh.wikisource.org/wiki/周易"
          target="_blank"
          rel="noreferrer"
        >
          卦名与上下卦参考：《周易》原文
        </a>
      </details>
    </div>
  );
}

export default function LeisureCorner() {
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<string>(leisureScenes[0].id);
  return (
    <div className="leisure-corner">
      <button
        className="leisure-entry nav-item"
        aria-label="打开娱乐角，三枚铜钱"
        title="娱乐角 · 三枚铜钱"
        onClick={() => setOpen(true)}
      >
        <Coins size={20} strokeWidth={1.7} />
        <span>娱乐角</span>
      </button>
      <Modal
        title="娱乐角"
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={540}
        destroyOnHidden
        className="leisure-dialog"
      >
        {leisureScenes.length > 1 ? (
          <Select
            aria-label="选择娱乐场景"
            className="leisure-scene-picker"
            value={scene}
            onChange={setScene}
            options={leisureScenes.map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
          />
        ) : (
          <h2 className="leisure-scene-title">三枚铜钱</h2>
        )}
        {scene === "three-coins" && <ThreeCoins />}
      </Modal>
    </div>
  );
}
