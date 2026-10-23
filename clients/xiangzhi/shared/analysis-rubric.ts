// Design reference: FerryCorleone/crush-monitor (MIT); see THIRD_PARTY_NOTICES.md.
export const ANALYSIS_RUBRIC_VERSION = "xiangzhi-communication-v4";
export const INTENT_LABELS = [
  "关心",
  "质问",
  "询问",
  "分享",
  "邀请",
  "玩笑",
  "表达不满",
  "其他",
  "回答问题",
  "确认理解",
  "解释说明",
  "表达认同",
  "倾诉烦恼",
  "寻求安慰",
  "请求帮助",
  "提供建议",
  "感谢",
  "道歉",
  "表达边界",
  "结束聊天",
  "难以判断",
] as const;
export const EMOTION_LABELS = [
  "开心",
  "疑惑",
  "生气",
  "难过",
  "害羞",
  "关切",
  "调侃",
  "平静",
  "不耐烦",
  "惊讶",
  "失落",
  "难以判断",
] as const;
export const AFFINITY_DIMENSIONS = [
  {
    key: "initiative",
    label: "主动延续",
    weight: 15,
    description: "是否主动开启、追问或延续具体话题；不用消息数量代替判断。",
  },
  {
    key: "engagement",
    label: "回应投入",
    weight: 20,
    description: "是否回应具体细节和表达重点；短句和回复慢本身不扣分。",
  },
  {
    key: "care",
    label: "关心体贴",
    weight: 20,
    description: "是否针对本人已表达的处境与需要提供具体关心。",
  },
  {
    key: "openness",
    label: "自我开放",
    weight: 15,
    description: "是否分享个人想法和感受；保留隐私本身不是负面信号。",
  },
  {
    key: "closeness",
    label: "亲近表达",
    weight: 20,
    description: "是否有双方接纳的特别亲近表达；普通礼貌和表情不自动计为暧昧。",
  },
  {
    key: "action",
    label: "实际行动",
    weight: 10,
    description: "是否确认、落实具体安排；未出现邀约机会时信息不足。",
  },
] as const;
export const REPLY_CRITERIA = [
  {
    key: "style",
    label: "符合本人习惯",
    description: "是否符合提供的习惯规则；没有习惯档案时无法判断。",
  },
  {
    key: "relevance",
    label: "接住话题",
    description: "是否回应当时对方的具体内容与情绪。",
  },
  {
    key: "clarity",
    label: "自然清楚",
    description: "措辞是否自然、清楚、分寸合适；不偏好冗长话术。",
  },
  {
    key: "factuality",
    label: "事实有据",
    description: "是否擅自添加经历、承诺或尚未确认的事实。",
  },
] as const;
export const EVENT_KINDS: Record<string, string> = {
  invitation: "邀约",
  confirmation: "安排确认",
  cancellation: "取消或改期",
  care: "关心支持",
  preference: "明确偏好",
  disclosure: "个人分享",
  boundary: "相处边界",
  correction: "澄清纠正",
  commitment: "明确承诺",
  question: "待答问题",
  other: "其他事件",
};
export const EVENT_STATES = {
  active: "仍有效／待完成",
  resolved: "已结束／已变更",
  uncertain: "状态待确认",
} as const;
export const analysisEnabled = (p?: {
  intentEnabled?: boolean;
  emotionEnabled?: boolean;
  affinityEnabled?: boolean;
  replyReviewEnabled?: boolean;
}) =>
  !!(
    p?.intentEnabled ||
    p?.emotionEnabled ||
    p?.affinityEnabled ||
    p?.replyReviewEnabled
  );
export function distributionPreview(
  items: { label: string; percentage: number }[],
  limit = 3,
) {
  const sorted = items.slice().sort((a, b) => b.percentage - a.percentage);
  return {
    items: sorted.slice(0, limit),
    remaining: sorted
      .slice(limit)
      .reduce((sum, item) => sum + item.percentage, 0),
  };
}
export function composeInteraction(
  dimensions: { key: string; score: number | null }[],
) {
  const observed = AFFINITY_DIMENSIONS.flatMap((d) => {
    const value = dimensions.find((item) => item.key === d.key)?.score;
    return typeof value === "number" ? [{ ...d, score: value }] : [];
  });
  const coverage = observed.reduce((sum, d) => sum + d.weight, 0);
  return {
    score:
      observed.length < 3
        ? null
        : Math.round(
            observed.reduce((sum, d) => sum + d.score * d.weight, 0) / coverage,
          ),
    coverage,
  };
}
