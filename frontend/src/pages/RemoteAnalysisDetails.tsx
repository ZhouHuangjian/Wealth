import type { RemoteCurrentMessage } from "../chat-current-model";
import type { RemoteProcessing } from "../chat-remote-model";

const labels: Record<string, string> = {
  initiative: "主动延续",
  engagement: "回应投入",
  care: "关心体贴",
  openness: "自我开放",
  closeness: "亲近表达",
  action: "实际行动",
  style: "符合本人习惯",
  relevance: "接住话题",
  clarity: "自然清楚",
  factuality: "事实有据",
};
export default function RemoteAnalysisDetails({
  analysis,
  processing,
  messages = [],
}: {
  analysis: RemoteCurrentMessage["analysis"];
  processing?: RemoteProcessing;
  messages?: RemoteCurrentMessage[];
}) {
  if (
    !analysis ||
    !(
      (processing?.intentEnabled && analysis.intents.length) ||
      (processing?.emotionEnabled && analysis.emotions?.length) ||
      (processing?.affinityEnabled && analysis.affinity) ||
      (processing?.replyReviewEnabled && analysis.replyReview)
    )
  )
    return null;
  const distribution = (
    name: string,
    items: { label: string; percentage: number }[],
  ) => {
    if (!items.length) return null;
    const sorted = items.slice().sort((a, b) => b.percentage - a.percentage),
      rest = sorted.slice(3).reduce((n, i) => n + i.percentage, 0);
    return (
      <div className="chat-current-distribution">
        <strong>{name}（模型估计）</strong>
        <div>
          {sorted.slice(0, 3).map((item) => (
            <span key={item.label}>
              {item.label} <b>{item.percentage}%</b>　
            </span>
          ))}
          {rest > 0 && <span>其余解读 {rest}%</span>}
        </div>
        {rest > 0 && (
          <details>
            <summary>完整分布</summary>
            {sorted.map((item) => (
              <span key={item.label}>
                {item.label} {item.percentage}%　
              </span>
            ))}
          </details>
        )}
      </div>
    );
  };
  const evidence = (ids: string[]) => (
    <details>
      <summary>原话依据（{ids.length}）</summary>
      {ids.length ? (
        ids.map((id) => {
          const message = messages.find((m) => m.id === id);
          return (
            <blockquote key={id}>
              {message
                ? `${message.role === "self" ? "我" : "对方"}：${message.text}`
                : "该原话尚未加载，可加载更早消息或在 Mac 查看。"}
            </blockquote>
          );
        })
      ) : (
        <p>相关信息不足</p>
      )}
    </details>
  );
  return (
    <div className="chat-current-analysis">
      {analysis.stale && <small>历史或模型有变化，待更新</small>}
      {processing?.emotionEnabled &&
        distribution("可能的情绪", analysis.emotions ?? [])}
      {processing?.intentEnabled &&
        distribution("可能的意图", analysis.intents)}
      {((processing?.emotionEnabled && !!analysis.emotions?.length) ||
        (processing?.intentEnabled && analysis.intents.length > 0)) && (
        <details>
          <summary>比例说明</summary>
          <p>
            模型对不同理解分配的相对权重，各项合计100%，不表示真实概率或情绪强度。前三项之外的解读保留在其余比例中。
          </p>
        </details>
      )}
      {processing?.affinityEnabled && analysis.affinity && (
        <details>
          <summary>
            互动分项 · {analysis.affinity.score ?? "信息不足"}
            {analysis.affinity.score !== null ? " 分" : ""}
          </summary>
          <p>
            原话证据覆盖 {analysis.affinity.coverage ?? "未知"}%；信息充分度{" "}
            {analysis.affinity.confidence}%，不表示正确率或恋爱概率。
          </p>
          {analysis.affinity.dimensions?.map((d) => (
            <div className="chat-analysis-dimension" key={d.key}>
              <b>{labels[d.key] ?? d.key}</b>：{d.score ?? "信息不足"}
              {evidence(d.evidenceMessageIds)}
            </div>
          ))}
          {!analysis.affinity.dimensions && <p>旧分析没有分项，请更新分析。</p>}
          {analysis.affinity.evidence?.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </details>
      )}
      {processing?.replyReviewEnabled && analysis.replyReview && (
        <details>
          <summary>
            本人回复复盘 · {analysis.replyReview.score ?? "信息不足"}
            {analysis.replyReview.score !== null ? " 分" : ""}
          </summary>
          <p>{analysis.replyReview.summary}</p>
          <small>基于当时上下文和本人习惯，不使用后续回复倒推。</small>
          {analysis.replyReview.criteria.map((c) => (
            <div className="chat-analysis-dimension" key={c.key}>
              <b>{labels[c.key] ?? c.key}</b>：{c.score ?? "信息不足"}
              {evidence(c.evidenceMessageIds)}
            </div>
          ))}
        </details>
      )}
      <small>
        {analysis.modelName || analysis.provider} ·{" "}
        {analysis.rubricVersion ?? "旧版规则"} ·{" "}
        {new Date(analysis.analyzedAt).toLocaleString("zh-CN")}
      </small>
    </div>
  );
}
