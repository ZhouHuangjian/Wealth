import type {
  ContactInsights,
  ContactProcessing,
  Message,
} from "../shared/types";
import {
  AFFINITY_DIMENSIONS,
  REPLY_CRITERIA,
  distributionPreview,
} from "../shared/analysis-rubric";

export function InsightBreakdown({
  insights,
  processing,
  messages = [],
}: {
  insights: ContactInsights;
  processing?: ContactProcessing;
  messages?: Message[];
}) {
  const distribution = (
    name: string,
    items: { label: string; percentage: number }[],
  ) => {
    const preview = distributionPreview(items);
    if (!items.length) return null;
    return (
      <div className="analysis-distribution">
        <span>{name}（模型估计）</span>
        <span className="intent-label-chips">
          {preview.items.map((item) => (
            <span key={item.label}>
              {item.label} <strong>{item.percentage}%</strong>
            </span>
          ))}
          {preview.remaining > 0 && (
            <span>
              其余解读 <strong>{preview.remaining}%</strong>
            </span>
          )}
        </span>
        {preview.remaining > 0 && (
          <details>
            <summary>查看完整分布</summary>
            {items.map((item) => (
              <span className="analysis-full-label" key={item.label}>
                {item.label} {item.percentage}%
              </span>
            ))}
          </details>
        )}
      </div>
    );
  };
  const evidence = (ids: string[]) =>
    ids.length ? (
      <details className="analysis-evidence">
        <summary>查看原话依据（{ids.length}）</summary>
        {ids.map((id) => {
          const m = messages.find((item) => item.id === id);
          return (
            <blockquote key={id}>
              {m
                ? `${m.role === "self" ? "我" : "对方"}：${m.audioRecognition?.text || m.text}`
                : "来源原话未加载，请在完整历史中查看。"}
            </blockquote>
          );
        })}
      </details>
    ) : (
      <small>相关信息不足</small>
    );
  const hasContent = !!(
    (processing?.intentEnabled && insights.intents.length) ||
    (processing?.emotionEnabled && insights.emotions?.length) ||
    (processing?.affinityEnabled && insights.affinity) ||
    (processing?.replyReviewEnabled && insights.replyReview)
  );
  if (!hasContent) return null;
  return (
    <div className="numeric-insights" aria-label="这条消息的交流分析">
      {insights.stale && (
        <p className="insight-stale-note">
          <strong>已保存的旧分析 · 待更新</strong>
          <span>
            聊天历史或分析配置已变化，更新分析后可纳入完整历史和当前配置。
          </span>
        </p>
      )}
      {processing?.emotionEnabled &&
        distribution("可能的情绪", insights.emotions ?? [])}
      {processing?.intentEnabled &&
        distribution("可能的意图", insights.intents)}
      {((processing?.intentEnabled && insights.intents.length > 0) ||
        (processing?.emotionEnabled && !!insights.emotions?.length)) && (
        <details className="intent-weight-help">
          <summary>比例说明</summary>
          <p>
            这些比例是模型对不同理解分配的相对权重，各项合计
            100%，不表示真实概率或情绪强度。只展示前三项时，其余解读单独列出。
          </p>
          {insights.intents.some((i) => i.label === "其他") && (
            <p>其他：未归入现有分类的可能含义。</p>
          )}
        </details>
      )}
      {processing?.affinityEnabled && insights.affinity && (
        <details className="analysis-dimensions">
          <summary>
            互动分项与依据 ·{" "}
            {insights.affinity.score === null
              ? "信息不足"
              : `${insights.affinity.score} 分`}
          </summary>
          <p>
            按有原话依据的维度加权；证据覆盖{" "}
            {insights.affinity.coverage ?? "未知"}%。信息充分度{" "}
            {insights.affinity.confidence}%，不代表正确率或恋爱概率。
          </p>
          {insights.affinity.dimensions?.map((d) => (
            <div className="analysis-dimension" key={d.key}>
              <strong>
                {AFFINITY_DIMENSIONS.find((item) => item.key === d.key)
                  ?.label ?? d.key}
              </strong>
              <span>{d.score === null ? "信息不足" : `${d.score} 分`}</span>
              {evidence(d.evidenceMessageIds)}
            </div>
          ))}
          {!insights.affinity.dimensions && (
            <p>旧分析没有分项，更新分析后可查看。</p>
          )}
          {insights.affinity.evidence.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </details>
      )}
      {processing?.replyReviewEnabled && insights.replyReview && (
        <details className="analysis-review">
          <summary>
            本人回复复盘 ·{" "}
            {insights.replyReview.score === null
              ? "信息不足"
              : `${insights.replyReview.score} 分`}
          </summary>
          <p>{insights.replyReview.summary}</p>
          <small>
            仅评价发出时的表达，参考本人习惯档案，不使用之后的回复倒推。
          </small>
          {insights.replyReview.criteria.map((c) => (
            <div className="analysis-dimension" key={c.key}>
              <strong>
                {REPLY_CRITERIA.find((item) => item.key === c.key)?.label ??
                  c.key}
              </strong>
              <span>{c.score === null ? "信息不足" : `${c.score} 分`}</span>
              {evidence(c.evidenceMessageIds)}
            </div>
          ))}
        </details>
      )}
      <small className="analysis-provenance">
        {insights.modelName || insights.provider} ·{" "}
        {insights.rubricVersion ?? "旧版规则"} ·{" "}
        {insights.analyzedAt
          ? new Date(insights.analyzedAt).toLocaleString("zh-CN")
          : ""}
      </small>
    </div>
  );
}
